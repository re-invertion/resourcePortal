import { Injectable, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
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

  private assertTrustedTokenEndpoint(value: string): void {
    try {
      const tokenEndpoint = new URL(value);
      const issuer = new URL(this.config.get<string>("OIDC_ISSUER_URL") ?? "");
      if (tokenEndpoint.protocol !== "https:" ||
          tokenEndpoint.origin !== issuer.origin ||
          tokenEndpoint.pathname !== "/oauth/v2/token" ||
          tokenEndpoint.search || tokenEndpoint.hash ||
          tokenEndpoint.username || tokenEndpoint.password) {
        throw new Error("Untrusted OIDC token metadata");
      }
    } catch {
      throw new ServiceUnavailableException("Untrusted ZITADEL token endpoint");
    }
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
    // Discovery may be corrupted or attacker-influenced. Reject unexpected
    // DCR endpoints BEFORE a non-idempotent upstream registration POST;
    // a deterministic local metadata error must not be reported as a
    // possibly accepted client. In particular, origin equality alone is
    // insufficient: require the one RFC7591 ZITADEL registration path.
    try {
      const registrationUrl = new URL(discovery.registrationEndpoint);
      const configuredIssuer = new URL(this.config.get<string>("OIDC_ISSUER_URL") ?? "");
      if (registrationUrl.protocol !== "https:" ||
          registrationUrl.origin !== configuredIssuer.origin ||
          registrationUrl.pathname !== "/oauth/v2/register" ||
          registrationUrl.search || registrationUrl.hash ||
          registrationUrl.username || registrationUrl.password) {
        throw new Error("Untrusted DCR metadata");
      }
    } catch {
      throw new ServiceUnavailableException("Untrusted ZITADEL DCR registration endpoint");
    }
    // Canonical RP origin validation happens before attempting the POST;
    // local configuration failures are not uncertain upstream mutations.
    const callbackUri = this.callback(origin);
    let response: Response;
    try {
      response = await this.transport().fetch(discovery.registrationEndpoint, "registration", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: `ResourcePortal MCP identity ${tenantId}`,
          redirect_uris: [callbackUri],
          application_type: "web",
          response_types: ["code"],
          grant_types: ["authorization_code"],
          token_endpoint_auth_method: "none",
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // The upstream may have persisted a DCR client before its response
      // failed. Never silently retry the non-idempotent registration POST.
      throw new ServiceUnavailableException({
        code: "MCP_IDENTITY_DCR_REGISTRATION_OUTCOME_UNCERTAIN",
        message: "ZITADEL MCP identity registration may have been accepted; reconcile upstream clients before retrying",
      });
    }
    if (response.status !== 201) {
      throw new ServiceUnavailableException("ZITADEL denied MCP identity client registration");
    }
    // A malicious or compromised issuer response must not persist arbitrary
    // clients into the privileged issuer-global exact-client allowlist.
    let raw: Record<string, unknown>;
    try {
      raw = await boundedJson(response);
    } catch {
      throw new ServiceUnavailableException({
        code: "MCP_IDENTITY_DCR_REGISTRATION_OUTCOME_UNCERTAIN",
        message: "ZITADEL MCP identity registration returned an unreadable accepted response; reconcile upstream clients before retrying",
      });
    }
    const clientId = raw.client_id;
    if (typeof clientId !== "string" || !/^\d{1,64}$/.test(clientId) ||
        !Array.isArray(raw.redirect_uris) ||
        raw.redirect_uris.length !== 1 || raw.redirect_uris[0] !== callbackUri ||
        raw.token_endpoint_auth_method !== "none") {
      throw new ServiceUnavailableException({
        code: "MCP_IDENTITY_DCR_REGISTRATION_OUTCOME_UNCERTAIN",
        message: "ZITADEL MCP identity registration returned invalid accepted metadata; reconcile upstream clients before retrying",
        ...(typeof clientId === "string" && /^\d{1,64}$/.test(clientId) ? { clientId } : {}),
      });
    }
    try {
      await this.prisma.mcpOAuthUpstreamClient.create({ data: { tenantId, clientId } });
      return clientId;
    } catch {
      // A concurrent registration can win the local unique constraint but
      // leave THIS accepted ZITADEL DCR application orphaned. Never return
      // the winning client as if this second registration was fully cleaned.
      // The newly returned numeric client ID is safe for read-only operator
      // reconciliation; its registration bearer is never returned or logged.
      throw new ServiceUnavailableException({
        code: "MCP_IDENTITY_DCR_PARTIAL_REGISTRATION",
        message: "ZITADEL MCP identity client was registered but its local binding was not confirmed; reconcile this client before retrying",
        clientId,
      });
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
    // Validate all local/public redirect and issuer metadata BEFORE the
    // non-idempotent upstream DCR registration. Invalid issuer discovery must
    // not leave a newly accepted, unused ZITADEL client behind.
    const callbackUri = this.callback(origin);
    const discovery = await this.oidc.getDiscovery();
    let authorizationUrl: URL;
    try {
      authorizationUrl = new URL(discovery.authorizationEndpoint);
      const configuredIssuer = new URL(this.config.get<string>("OIDC_ISSUER_URL") ?? "");
      if (authorizationUrl.protocol !== "https:" ||
          authorizationUrl.origin !== configuredIssuer.origin ||
          authorizationUrl.pathname !== "/oauth/v2/authorize" ||
          authorizationUrl.search || authorizationUrl.hash ||
          authorizationUrl.username || authorizationUrl.password) {
        throw new Error("Untrusted issuer metadata");
      }
    } catch {
      throw new ServiceUnavailableException("Untrusted ZITADEL authorization endpoint");
    }
    // A DCR client must never be created for an issuer whose OAuth code
    // exchange endpoint is invalid. Validate BEFORE non-idempotent POST.
    this.assertTrustedTokenEndpoint(discovery.tokenEndpoint);
    const clientId = await this.upstreamClient(input.tenantId, origin);
    const verifier = codeToken();
    const state = codeToken();
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
    authorizationUrl.searchParams.set("redirect_uri", callbackUri);
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
    // Do not allow an invalid callback origin to burn a valid one-time login.
    // The canonical public origin is verified before any state mutation.
    this.callback(origin);
    const record = await this.prisma.mcpOAuthUpstreamLogin.findUnique({
      where: { stateHash: hash(state) },
    });
    if (!record || record.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException("Expired MCP identity OAuth state");
    }
    // Check untrusted discovery metadata BEFORE consuming the one-time login
    // state. A malformed token endpoint must neither receive a valid code
    // nor permanently invalidate a legitimate pending callback.
    const discovery = await this.oidc.getDiscovery();
    this.assertTrustedTokenEndpoint(discovery.tokenEndpoint);
    // Validate the tenant, current bound identity client and exact resource
    // audience BEFORE consuming the pending state. Unauthorized callbacks
    // must not DoS a legitimate user's ongoing authentication transaction.
    const upstreamClient = await this.prisma.mcpOAuthUpstreamClient.findUnique({
      where: { tenantId: record.tenantId },
    });
    if (!upstreamClient || upstreamClient.clientId !== record.upstreamClientId ||
        record.resource !== `${origin}/api/tenants/${record.tenantId}/mcp`) {
      throw new UnauthorizedException("MCP identity client or resource mismatch");
    }
    const consumed = await this.prisma.mcpOAuthUpstreamLogin.deleteMany({
      where: { stateHash: record.stateHash, expiresAt: { gt: new Date() } },
    });
    if (consumed.count !== 1) {
      throw new UnauthorizedException("MCP identity OAuth state was already used");
    }
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
    if (!response.ok) {
      // ZITADEL can return Errors.AuthRequest.NotFound even when the browser
      // received a fresh code (#498). Classify the response without ever
      // logging or returning code, state, verifier, upstream body or token.
      const failure = await boundedJson(response).catch(() => null);
      const missingRequest = failure?.error_description === "Errors.AuthRequest.NotFound" ||
        failure?.error === "Errors.AuthRequest.NotFound";
      throw new UnauthorizedException({
        code: missingRequest ? "MCP_IDENTITY_AUTH_REQUEST_NOT_FOUND" : "MCP_IDENTITY_CODE_EXCHANGE_DENIED",
        message: missingRequest
          ? "The identity provider could not find this sign-in request; start a new sign-in"
          : "MCP identity code exchange denied",
      });
    }
    const payload = await boundedJson(response);
    if (typeof payload.id_token !== "string" || payload.id_token.length > 32_768 ||
        typeof payload.access_token !== "string" || !payload.access_token ||
        payload.access_token.length > 32_768) {
      throw new UnauthorizedException("ZITADEL MCP identity code exchange tokens missing");
    }
    // Only the server-side callback receives this short-lived access token.
    // Never return it to ChatGPT, expose it as an RP Web session, or persist it.
    // Its sole purpose is subject-bound UserInfo when signed ID tokens omit
    // email_verified, as permitted by ZITADEL's OIDC code flow.
    return { record, idToken: payload.id_token, accessToken: payload.access_token };
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
