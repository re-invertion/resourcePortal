import {
  ForbiddenException, Injectable, ServiceUnavailableException, UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, randomBytes } from "node:crypto";
import { OidcAuthService } from "../auth/oidc-auth.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantsService } from "./tenants.service";

/** Isolated identity proof only. Never creates a normal RP session or requests RP audience. */
@Injectable()
export class TenantInvitationOnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly oidc: OidcAuthService,
    private readonly tenants: TenantsService,
    private readonly config: ConfigService,
  ) {}

  // Public invitation preview discloses only whether this deployment has
  // activated the isolated first-login flow; no client ID or secret is sent.
  isOnboardingAvailable(): boolean {
    if (this.config.get<string>("RP_APP_CONSUMER_ACTIONS_V2_ENABLED") !== "true" ||
        this.config.get<string>("RP_APP_CONSUMER_ACTIONS_V2_CERTIFIED") !== "true") return false;
    try {
      this.client();
      return true;
    } catch {
      return false;
    }
  }

  private client() {
    const id = this.config.get<string>("OIDC_INVITATION_CLIENT_ID");
    const secret = this.config.get<string>("OIDC_INVITATION_CLIENT_SECRET");
    const redirectUri = this.config.get<string>("OIDC_INVITATION_REDIRECT_URI");
    if (this.config.get<string>("RP_INVITATION_ONBOARDING_ENABLED") !== "true" ||
        !id || id === this.config.get<string>("OIDC_CLIENT_ID") ||
        id === this.config.get<string>("OIDC_CLI_CLIENT_ID") ||
        !secret || secret.length < 24 || !redirectUri) {
      throw new ServiceUnavailableException("Isolated invitation login is not configured");
    }
    let url: URL;
    try { url = new URL(redirectUri); }
    catch { throw new ServiceUnavailableException("Invalid invitation callback configuration"); }
    if (url.protocol !== "https:" || url.pathname !== "/api/invitations/onboard/callback" ||
        url.search || url.hash || url.username || url.password) {
      throw new ServiceUnavailableException("Invalid secure invitation callback configuration");
    }
    return { id, secret, redirectUri };
  }

  private async invitation(token: string) {
    if (!/^[a-zA-Z0-9_-]{32,128}$/.test(token)) {
      throw new ForbiddenException("Invalid or expired invitation");
    }
    const invitation = await this.prisma.tenantInvitation.findUnique({
      where: { tokenHash: createHash("sha256").update(token).digest("hex") },
      select: { email: true, expiresAt: true, roleIds: true,
        tenantId: true, nativeApplicationKeys: true },
    });
    if (!invitation || invitation.expiresAt <= new Date() ||
        !invitation.roleIds.includes("sso-login")) {
      throw new ForbiddenException("Invalid or expired SSO invitation");
    }
    return invitation;
  }

  async start(token: string, registration: boolean) {
    const client = this.client();
    await this.invitation(token);
    const discovery = await this.oidc.getDiscovery();
    const url = new URL(discovery.authorizationEndpoint);
    if (url.protocol !== "https:") {
      throw new ServiceUnavailableException("Secure issuer authorization URL required");
    }
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    url.searchParams.set("client_id", client.id);
    url.searchParams.set("redirect_uri", client.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid profile email");
    url.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", state);
    if (registration) url.searchParams.set("prompt", "create");
    return { url: url.toString(), state, verifier, token };
  }

  async complete(code: string, state: string, expectedState: string | undefined,
    verifier: string | undefined, token: string | undefined) {
    if (!code || !state || !expectedState || state !== expectedState || !verifier || !token) {
      throw new UnauthorizedException("Invalid invitation OAuth callback state");
    }
    const client = this.client();
    const invite = await this.invitation(token);
    const discovery = await this.oidc.getDiscovery();
    const response = await fetch(discovery.tokenEndpoint, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: "Basic " + Buffer.from(client.id + ":" + client.secret).toString("base64"),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code", client_id: client.id, code,
        code_verifier: verifier, redirect_uri: client.redirectUri,
      }),
    });
    if (!response.ok) throw new UnauthorizedException("Invitation OAuth exchange denied");
    const payload = await response.json() as { id_token?: unknown; access_token?: unknown };
    if (typeof payload.id_token !== "string" || typeof payload.access_token !== "string") {
      throw new UnauthorizedException("Invitation ID token missing");
    }
    const actor = await this.oidc.authenticateInvitationTokens(
      payload.id_token, payload.access_token, state, invite.email,
    );
    // Tenant membership/SSO/native grants/consume-token/audit are atomic in
    // TenantsService.acceptInvitation. No RP session exists until a FRESH
    // ordinary Web login is authorized against that committed membership.
    const membership = await this.tenants.acceptInvitation({ token }, actor);
    return { tenantId: membership.tenantId,
      webGranted: invite.nativeApplicationKeys.includes("web") };
  }
}
