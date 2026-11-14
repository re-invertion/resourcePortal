import { Injectable, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";
import { OidcAuthService } from "./oidc-auth.service";
import { OidcIssuerTransport } from "./oidc-issuer-transport";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "../security/encryption.service";
import type { AuthenticatedUser } from "./types";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const codeToken = () => randomBytes(32).toString("base64url");

type LoginInput = {
  tenantId: string; clientId: string; resource: string; redirectUri: string;
  challenge: string; clientState: string; scope: string;
};

/** Separate identity-only ZITADEL DCR client for the MCP consent journey.
 * It cannot mint RP Web tokens or impersonate the MCP resource issuer.
 *
 * The RP server, NOT the browser, registers the client. The ZITADEL issuer
 * Action requires its exact persisted clientId and the user’s tenant MCP
 * entitlement before it will issue this client a signed ID token.
 */
@Injectable()
export class McpUpstreamLoginService {
  private oidcTransport?: OidcIssuerTransport;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly oidc: OidcAuthService,
    private readonly encryption: EncryptionService,
  ) {}

  private transport() {
    return this.oidcTransport ??= new OidcIssuerTransport(
      this.config.get<string>("OIDC_ISSUER_URL") ?? "",
      this.config.get<string>("OIDC_PRIVATE_TLS_ROUTE"),
    );
  }

  private callback(origin: string) {
    if (!origin.startsWith("https://") || new URL(origin).origin !== origin) {
      throw new ServiceUnavailableException("Canonical public RP origin is required");
    }
    return `${origin}/api/mcp/oauth/upstream/callback`;
  }

  private async upstreamClient(tenantId: string, origin: string) {
    const existing = await this.prisma.mcpOAuthUpstreamClient.findUnique({
      where: { tenantId },
    });
    if (existing) return existing.clientId;

    const discovery = await this.oidc.getDiscovery();
    if (!discovery.registrationEndpoint) {
      throw new ServiceUnavailableException("ZITADEL DCR registration is not available");
    }
    const response = await this.transport().fetch(discovery.registrationEndpoint, "registration", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: `ResourcePortal MCP identity ${tenantId}`,
        redirect_uris: [this.callback(origin)],
        application_type: "web",
        response_types: ["code"],
        grant_types: ["authorization_code"],
        token_endpoint_auth_method: "none",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 201) {
      throw new ServiceUnavailableException("ZITADEL denied MCP identity client registration");
    }
    // A malicious or compromised issuer response must not persist arbitrary
    // clients into the privileged issuer-global exact-client allowlist.
    const raw = await boundedJson(response);
    const clientId = raw.client_id;
    if (typeof clientId !== "string" || !/^\d{1,64}$/.test(clientId) ||
        !Array.isArray(raw.redirect_uris) ||
        raw.redirect_uris.length !== 1 || raw.redirect_uris[0] !== this.callback(origin) ||
        raw.token_endpoint_auth_method !== "none") {
      throw new ServiceUnavailableException("ZITADEL MCP identity registration is invalid");
    }
    try {
      await this.prisma.mcpOAuthUpstreamClient.create({ data: { tenantId, clientId } });
      return clientId;
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
        throw error;
      }
      // Concurrent first connect is only allowed to use the existing DB
      // record; the losing client's DCR app is *not* authorized by the Action.
      const winner = await this.prisma.mcpOAuthUpstreamClient.findUnique({
        where: { tenantId },
      });
      if (!winner) throw new ServiceUnavailableException("MCP upstream registration race");
      return winner.clientId;
    }
  }

  async start(input: LoginInput, origin: string) {
    if (this.config.get<string>("RP_APP_CONSUMER_ACTIONS_V2_ENABLED") !== "true" ||
        this.config.get<string>("RP_APP_CONSUMER_ACTIONS_V2_CERTIFIED") !== "true") {
      throw new ServiceUnavailableException("MCP-only ZITADEL identity target is not certified");
    }
    if (input.resource !== `${origin}/api/tenants/${input.tenantId}/mcp`) {
      throw new UnauthorizedException("MCP resource audience mismatch");
    }
    const clientId = await this.upstreamClient(input.tenantId, origin);
    const verifier = codeToken();
    const state = codeToken();
    const discovery = await this.oidc.getDiscovery();
    const authorizationUrl = new URL(discovery.authorizationEndpoint);
    if (authorizationUrl.protocol !== "https:" ||
        authorizationUrl.origin !== new URL(this.config.get<string>("OIDC_ISSUER_URL") ?? "").origin) {
      throw new ServiceUnavailableException("Untrusted ZITADEL authorization endpoint");
    }
    await this.prisma.mcpOAuthUpstreamLogin.create({ data: {
      stateHash: hash(state),
      clientId: input.clientId,
      tenantId: input.tenantId,
      upstreamClientId: clientId,
      resource: input.resource,
      redirectUri: input.redirectUri,
      clientState: input.clientState,
      scope: input.scope,
      codeChallenge: input.challenge,
      verifierCipher: this.encryption.encrypt(verifier),
      expiresAt: new Date(Date.now() + 600_000),
    } });
    authorizationUrl.searchParams.set("client_id", clientId);
    authorizationUrl.searchParams.set("redirect_uri", this.callback(origin));
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("scope", "openid profile email");
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("nonce", state);
    authorizationUrl.searchParams.set("code_challenge", createHash("sha256")
      .update(verifier).digest("base64url"));
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    return { state, url: authorizationUrl.toString() };
  }

  async exchange(code: unknown, state: unknown, origin: string) {
    if (typeof code !== "string" || !code || code.length > 2048 ||
        typeof state !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(state)) {
      throw new UnauthorizedException("Invalid MCP identity OAuth callback");
    }
    const record = await this.prisma.mcpOAuthUpstreamLogin.findUnique({
      where: { stateHash: hash(state) },
    });
    if (!record || record.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException("Expired MCP identity OAuth state");
    }
    const consumed = await this.prisma.mcpOAuthUpstreamLogin.deleteMany({
      where: { stateHash: record.stateHash, expiresAt: { gt: new Date() } },
    });
    if (consumed.count !== 1) {
      throw new UnauthorizedException("MCP identity OAuth state was already used");
    }
    const upstreamClient = await this.prisma.mcpOAuthUpstreamClient.findUnique({
      where: { tenantId: record.tenantId },
    });
    if (!upstreamClient || upstreamClient.clientId !== record.upstreamClientId ||
        record.resource !== `${origin}/api/tenants/${record.tenantId}/mcp`) {
      throw new UnauthorizedException("MCP identity client or resource mismatch");
    }
    const discovery = await this.oidc.getDiscovery();
    const response = await this.transport().fetch(discovery.tokenEndpoint, "code-exchange", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: record.upstreamClientId,
        grant_type: "authorization_code",
        code,
        code_verifier: this.encryption.decrypt(record.verifierCipher),
        redirect_uri: this.callback(origin),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new UnauthorizedException("MCP identity code exchange denied");
    const payload = await boundedJson(response);
    if (typeof payload.id_token !== "string" || payload.id_token.length > 32_768) {
      throw new UnauthorizedException("ZITADEL MCP identity ID token missing");
    }
    return { record, idToken: payload.id_token };
  }

  async createIdentitySession(user: AuthenticatedUser, tenantId: string) {
    const token = codeToken();
    await this.prisma.mcpOAuthBrowserSession.create({ data: {
      sessionHash: hash(token), userId: user.id, tenantId,
      authenticatedIdpId: user.authenticatedIdpId ?? null,
      expiresAt: new Date(Date.now() + 600_000),
    } });
    return token;
  }
}

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new ServiceUnavailableException("Missing ZITADEL response");
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk: unknown = next.value;
      if (!(chunk instanceof Uint8Array)) {
        throw new ServiceUnavailableException("Malformed ZITADEL response chunk");
      }
      length += chunk.length;
      if (length > 65_536) throw new ServiceUnavailableException("Oversized ZITADEL OAuth response");
      parts.push(chunk);
    }
    const parsed: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ServiceUnavailableException("Malformed ZITADEL OAuth response");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ServiceUnavailableException) throw error;
    throw new ServiceUnavailableException("Malformed ZITADEL OAuth response");
  } finally {
    reader.releaseLock();
  }
}
