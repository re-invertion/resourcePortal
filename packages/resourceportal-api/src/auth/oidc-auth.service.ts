import { Injectable, Logger, Optional, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { FederationProofService } from "./federation-proof.service";
import { OidcIssuerTransport } from "./oidc-issuer-transport";
import { ConfigService } from "@nestjs/config";
import { UserStatus } from "@prisma/client";
import type { JWTPayload, JWTVerifyOptions } from "jose";
import { PrismaService } from "../prisma/prisma.service";
import {
  AuthenticatedServiceIdentity,
  AuthenticatedUser,
} from "./types";

type JoseModule = typeof import("jose");
type RemoteJWKSet = ReturnType<JoseModule["createRemoteJWKSet"]>;

export type OidcDiscovery = {
  authorizationEndpoint: string;
  issuer: string;
  jwksUri: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  deviceAuthorizationEndpoint?: string;
  userInfoEndpoint?: string;
  revocationEndpoint?: string;
  introspectionEndpoint?: string;
  endSessionEndpoint?: string;
  scopesSupported?: string[];
  responseTypesSupported?: string[];
  responseModesSupported?: string[];
  grantTypesSupported?: string[];
  tokenEndpointAuthMethodsSupported?: string[];
  codeChallengeMethodsSupported?: string[];
  authorizationResponseIssParameterSupported?: boolean;
};

export type AuthenticatedPrincipal =
  | { type: "User"; user: AuthenticatedUser }
  | { type: "ServiceIdentity"; serviceIdentity: AuthenticatedServiceIdentity };

type ServiceIdentityRecord = {
  id: string;
  tenantId: string | null;
  name: string;
  status: "Active" | "Suspended";
  zitadelUserId: string;
  clientId: string;
};

@Injectable()
export class OidcAuthService {
  private readonly logger = new Logger(OidcAuthService.name);
  private discovery?: OidcDiscovery;
  private discoveryPromise?: Promise<OidcDiscovery>;
  private jwks?: RemoteJWKSet;
  private issuerTransport?: OidcIssuerTransport;
  private issuerConnectivityProbe?: Promise<void>;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    @Optional() private readonly federationProof?: FederationProofService,
  ) {}

  async authenticateBearerToken(
    token: string,
    identityProviderId?: string,
  ): Promise<AuthenticatedUser> {
    const payload = await this.verifyToken(token);
    return this.findOrProvisionUser(this.getIssuer(), payload, identityProviderId);
  }

  async authenticateBrowserTokens(
    idToken: string,
    accessToken: string,
    identityProviderId?: string,
    loginNonce?: string,
    rejectFederated = false,
    trustedWebCodeExchange = false,
  ): Promise<AuthenticatedUser> {
    // Only AuthFlowService.handleCallback may set this after exchanging the
    // state/PKCE-bound code with the configured Web client.
    const idTokenClaims = await this.verifyToken(idToken, undefined, trustedWebCodeExchange);
    this.assertOidcClientBinding(idTokenClaims, this.config.get<string>("OIDC_CLIENT_ID"), "browser");
    let authenticatedIdpId = this.verifiedAuthenticationIdpId(idTokenClaims);
    if (identityProviderId) {
      const selected = await this.prisma.identityProvider.findUnique({
        where: { id: identityProviderId },
        select: { enabled: true, zitadelIdentityProviderId: true },
      });
      if (!selected?.enabled || !selected.zitadelIdentityProviderId) {
        throw new UnauthorizedException("Selected external identity provider was not verified");
      }
      if (!authenticatedIdpId) {
        // The ZITADEL External Authentication action attests the *actual*
        // provider through a shared-secret server-to-server call. RP's
        // freshly generated OAuth state binds that evidence to this callback.
        // It is atomically consumed and cannot be a browser-provided assertion.
        const verified = loginNonce && await this.federationProof?.consume(
          loginNonce, selected.zitadelIdentityProviderId,
        );
        if (!verified) {
          throw new UnauthorizedException("Selected external identity provider was not verified");
        }
        authenticatedIdpId = selected.zitadelIdentityProviderId;
      } else if (authenticatedIdpId !== selected.zitadelIdentityProviderId) {
        throw new UnauthorizedException("Selected external identity provider was not verified");
      }
    }
    if (rejectFederated && authenticatedIdpId) {
      throw new UnauthorizedException("External identity provider login is disabled");
    }
    const humanClaims = await this.resolveHumanClaims(accessToken, idTokenClaims);
    const user = await this.findOrProvisionUser(this.getIssuer(), humanClaims, identityProviderId);
    return { ...user, authenticatedIdpId };
  }

  /**
   * Dedicated, short-lived invitation client: signed ID-token identity proof,
   * not an RP login. Its tokens MUST NOT create a PortalSession or authorize
   * RP bearer APIs. The caller must verify the opaque invitation both before
   * the code exchange and inside the atomic membership-accept transaction.
   */
  async authenticateInvitationTokens(
    idToken: string, accessToken: string, nonce: string, invitedEmail: string,
  ): Promise<AuthenticatedUser> {
    const client = this.config.get<string>("OIDC_INVITATION_CLIENT_ID");
    if (this.config.get<string>("RP_INVITATION_ONBOARDING_ENABLED") !== "true" ||
        !client || client === this.config.get<string>("OIDC_CLIENT_ID") ||
        client === this.config.get<string>("OIDC_CLI_CLIENT_ID")) {
      throw new UnauthorizedException("Isolated invitation client unavailable");
    }
    const claims = await this.verifyToken(idToken, client);
    this.assertOidcClientBinding(claims, client, "invitation");
    if (!nonce || claims.nonce !== nonce || this.verifiedAuthenticationIdpId(claims)) {
      throw new UnauthorizedException("Invitation identity proof is invalid");
    }
    const human = await this.resolveHumanClaims(accessToken, claims);
    if (human.email_verified !== true ||
        this.getEmail(human) !== invitedEmail.trim().toLowerCase()) {
      throw new UnauthorizedException("Verified invitation email mismatch");
    }
    // Never merge two distinct issuer+subject identities based on email alone.
    // Only the explicit, validated invitation callback can create a new User
    // when the normal OIDC_AUTO_PROVISION_USERS setting is disabled.
    const user = await this.findOrProvisionUser(this.getIssuer(), human, undefined, true);
    if (user.status !== UserStatus.Active) {
      throw new UnauthorizedException("Invited identity is not active");
    }
    return user;
  }

  /**
   * Identity-only upstream OAuth for a resource-specific MCP authorization.
   * An arbitrary ZITADEL bearer token (including a native RP Web or CLI token)
   * cannot be used for MCP bootstrap. Require an ID token signed by our
   * issuer, scoped to the exact upstream client ID, nonce, and an
   * already-linked active account. No email-based account linking/provisioning.
   * This is called only after RP itself exchanges a PKCE-bound code for
   * that exact client; the signed azp/client_id must match IF present,
   * because ZITADEL does not always emit them on single-audience ID tokens.
   */
  async authenticateMcpBootstrapTokens(
    idToken: string, clientId: string, nonce: string, accessToken?: string,
  ): Promise<AuthenticatedUser> {
    if (!/^\d{1,64}$/.test(clientId) ||
        !/^[A-Za-z0-9_-]{43}$/.test(nonce) ||
        [this.config.get<string>("OIDC_CLIENT_ID"),
          this.config.get<string>("OIDC_CLI_CLIENT_ID"),
          this.config.get<string>("OIDC_INVITATION_CLIENT_ID")].includes(clientId)) {
      throw new UnauthorizedException("Untrusted MCP identity OAuth client");
    }
    const claims = await this.verifyToken(idToken, clientId);
    // Upstream PKCE code exchange proves the registration's exact client;
    // a signed claim disagreeing with that client is always refused.
    if ((claims.azp !== undefined && claims.azp !== clientId) ||
        (claims.client_id !== undefined && claims.client_id !== clientId) ||
        claims.nonce !== nonce ||
        typeof claims.sub !== "string" || !/^\d{1,64}$/.test(claims.sub)) {
      throw new UnauthorizedException("Unbound MCP upstream identity proof");
    }
    // Some ZITADEL code-flow clients place email verification only in the
    // UserInfo response, not the signed ID token. We accept that ONLY after
    // the signed client+nonce+subject proof above, only with the access token
    // returned by the SAME server-side PKCE code exchange, and only if
    // the UserInfo subject equals the ID token's signed subject.
    if (claims.email_verified !== true) {
      if (claims.email_verified === false || !accessToken) {
        throw new UnauthorizedException("MCP upstream email verification required");
      }
      const userInfo = await this.fetchUserInfo(accessToken, claims.sub);
      if (userInfo.email_verified !== true) {
        throw new UnauthorizedException("MCP upstream email verification required");
      }
    }
    const linked = await this.prisma.userIdentity.findUnique({
      where: {
        issuer_externalSubject: {
          issuer: this.getIssuer(), externalSubject: claims.sub,
        },
      },
      include: { user: true },
    });
    if (!linked || linked.providerType !== "zitadel" ||
        linked.identityProviderId !== null ||
        linked.user.status !== UserStatus.Active) {
      throw new UnauthorizedException("MCP identity is not an active linked account");
    }
    const provider = this.verifiedAuthenticationIdpId(claims);
    return {
      id: linked.user.id, email: linked.user.email,
      displayName: linked.user.displayName, status: linked.user.status,
      ...(provider ? { authenticatedIdpId: provider } : {}),
    };
  }

  async authenticateMcpPrincipalToken(token: string, rejectFederated = false): Promise<AuthenticatedPrincipal> {
    const payload = await this.verifyToken(token);
    this.assertMcpTokenClaims(payload);
    return this.authenticateVerifiedPrincipal(token, payload, rejectFederated);
  }

  async authenticatePrincipalToken(token: string, rejectFederated = false): Promise<AuthenticatedPrincipal> {
    const payload = await this.verifyToken(token);
    return this.authenticateVerifiedPrincipal(token, payload, rejectFederated);
  }

  private async authenticateVerifiedPrincipal(
    token: string,
    payload: JWTPayload,
    rejectFederated: boolean,
  ): Promise<AuthenticatedPrincipal> {
    const subject = this.requireStringClaim(payload.sub, "sub");
    const serviceIdentity = await this.findServiceIdentity(subject);

    if (serviceIdentity) {
      if (serviceIdentity.status !== "Active") {
        throw new UnauthorizedException("Service identity is suspended");
      }
      return {
        type: "ServiceIdentity",
        serviceIdentity,
      };
    }

    // The claim is signed and issuer-verified. Reject BEFORE UserInfo and
    // findOrProvisionUser, which can create identities or mutate user records.
    const authenticatedIdpId = this.verifiedAuthenticationIdpId(payload);
    if (rejectFederated && authenticatedIdpId) {
      throw new UnauthorizedException("External identity provider login is disabled");
    }
    const humanClaims = await this.resolveHumanClaims(token, payload);
    return {
      type: "User",
      user: {
        ...await this.findOrProvisionUser(this.getIssuer(), humanClaims),
        authenticatedIdpId,
      },
    };
  }

  private async resolveHumanClaims(
    token: string,
    payload: JWTPayload,
  ): Promise<JWTPayload> {
    if (typeof payload.email === "string" && payload.email.length > 0) {
      return payload;
    }

    const subject = this.requireStringClaim(payload.sub, "sub");
    return this.fetchUserInfo(token, subject);
  }

  /**
   * Only a signed, issuer-verified token claim produced by the Zitadel login
   * action may establish the IdP used for THIS authentication event. Never
   * infer it from an account's historical linked identities, request params,
   * UserInfo, or the login selection cookie.
   */
  private verifiedAuthenticationIdpId(payload: JWTPayload): string | null {
    const claim = payload["urn:resourceportal:auth:external_idp_id"];
    return typeof claim === "string" && /^[a-zA-Z0-9_-]{1,256}$/.test(claim)
      ? claim
      : null;
  }

  private transport(): OidcIssuerTransport {
    return this.issuerTransport ??= new OidcIssuerTransport(
      this.getIssuer(),
      this.config.get<string>("OIDC_PRIVATE_TLS_ROUTE"),
    );
  }

  fetchIssuerEndpoint(url: string | URL, stage: "code-exchange" | "refresh" | "revoke",
    init: RequestInit = {}): Promise<Response> {
    return this.transport().fetch(url, stage, init);
  }

  // Always probe through a fresh network connection from the API container;
  // cached discovery alone does not establish readiness after Swarm rollout.
  async probeIssuerConnectivity(): Promise<void> {
    // Public /health/oidc is rate-limited, but one concurrent probe per API
    // replica also bounds IdP sockets during an outage or distributed flood.
    // No success cache: release health always checks the actual current path.
    this.issuerConnectivityProbe ??= this.fetchIssuerConnectivity().finally(() => {
      this.issuerConnectivityProbe = undefined;
    });
    return this.issuerConnectivityProbe;
  }

  private async fetchIssuerConnectivity(): Promise<void> {
    const response = await this.transport().fetch(
      this.getIssuer() + "/.well-known/openid-configuration", "readiness",
      { signal: AbortSignal.timeout(6000) },
    );
    if (!response.ok) throw new ServiceUnavailableException("OIDC discovery is unavailable");
    let metadata: Record<string, unknown>;
    try { metadata = await response.json() as Record<string, unknown>; } catch {
      throw new ServiceUnavailableException("OIDC discovery response is malformed");
    }
    if (metadata.issuer !== this.getIssuer() || typeof metadata.jwks_uri !== "string") {
      throw new ServiceUnavailableException("OIDC discovery issuer or JWKS URI is invalid");
    }
    this.transport().assertIssuerEndpoint(metadata.jwks_uri, "jwks");
    const keys = await this.transport().fetch(metadata.jwks_uri, "jwks",
      { signal: AbortSignal.timeout(6000) });
    if (!keys.ok) throw new ServiceUnavailableException("OIDC JWKS endpoint is unavailable");
    let jwks: { keys?: unknown };
    try { jwks = await keys.json() as { keys?: unknown }; } catch {
      throw new ServiceUnavailableException("OIDC JWKS response is malformed");
    }
    if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) {
      throw new ServiceUnavailableException("OIDC JWKS response is empty");
    }
  }

  private async fetchUserInfo(
    token: string,
    expectedSubject: string,
  ): Promise<JWTPayload> {
    const discovery = await this.getDiscovery();
    if (!discovery.userInfoEndpoint) {
      throw new UnauthorizedException("OIDC UserInfo endpoint is unavailable");
    }

    const response = await this.transport().fetch(discovery.userInfoEndpoint, "userinfo", {
      signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new UnauthorizedException("OIDC UserInfo request failed");
    }

    const claims = (await response.json()) as JWTPayload;
    if (claims.sub !== expectedSubject) {
      throw new UnauthorizedException("OIDC UserInfo subject mismatch");
    }
    return claims;
  }

  private async verifyToken(token: string, invitationAudience?: string, trustedWebCodeExchange = false) {
    const { jwtVerify } = await import("jose");
    const issuer = this.getIssuer();
    const jwks = await this.getJwks();
    const verifyOptions: JWTVerifyOptions = { issuer };
    const audience = invitationAudience ? [invitationAudience] : this.getAudience();

    if (audience.length > 0) {
      verifyOptions.audience = audience.length === 1 ? audience[0] : audience;
    }

    try {
      const result = await jwtVerify(token, jwks, verifyOptions);
      if (!invitationAudience) {
        const onboardingClient = this.config.get<string>("OIDC_INVITATION_CLIENT_ID");
        const aud = Array.isArray(result.payload.aud) ? result.payload.aud
          : typeof result.payload.aud === "string" ? [result.payload.aud] : [];
        // ZITADEL can put several audiences on an issued token. An audience
        // is a resource recipient, NOT proof of which OAuth client obtained the
        // authorization code. Do not reject a genuine Web/CLI token merely
        // because it also lists the invitation application as an audience.
        //
        // Conversely, neither an invitation-origin token nor an ambiguous
        // multi-audience token may become a normal RP API credential.
        const webClient = this.config.get<string>("OIDC_CLIENT_ID");
        const cliClient = this.config.get<string>("OIDC_CLI_CLIENT_ID");
        const nativeClients = [webClient, cliClient].filter(
          (value): value is string => Boolean(value),
        );
        const issuedForInvitation = Boolean(onboardingClient && (
          result.payload.azp === onboardingClient ||
          result.payload.client_id === onboardingClient
        ));
        const audienceIncludesInvitation = Boolean(
          onboardingClient && aud.includes(onboardingClient),
        );
        const nativeAudience = nativeClients.some((value) => aud.includes(value));
        const nativeIssuerProof = nativeClients.some((value) =>
          result.payload.azp === value || result.payload.client_id === value,
        );
        // For callback ID tokens, a successful confidential code+PKCE
        // exchange also proves the Web client, even when the issuer omits
        // azp/client_id on a multi-audience ID token. NEVER apply this
        // exception to arbitrary bearer/CLI/MCP credentials.
        const rejected = issuedForInvitation ||
          (audienceIncludesInvitation &&
            (!nativeAudience || (!nativeIssuerProof && !trustedWebCodeExchange)));
        if (rejected) {
          this.logger.warn(JSON.stringify({
            code: "OIDC_INVITATION_CLIENT_CONFLICT",
            audienceMatched: audienceIncludesInvitation,
            azpMatched: result.payload.azp === onboardingClient,
            clientIdMatched: result.payload.client_id === onboardingClient,
            nativeAudience,
            nativeIssuerProof,
            trustedWebCodeExchange,
          }));
          throw new UnauthorizedException("Invitation token is not an RP API credential");
        }
      }
      return result.payload;
    } catch (error) {
      // Unreachable JWKS is not proof of invalid credentials. Preserve a
      // retryable 503 without weakening JWT signature/issuer verification.
      if (error instanceof ServiceUnavailableException) throw error;
      throw new UnauthorizedException("OIDC bearer token is invalid");
    }
  }

  /**
   * Bind an ID token to the OAuth application used in the corresponding
   * authorization-code exchange. Project/global audiences are insufficient.
   * Reject contradictory azp/client_id; these are signed issuer claims.
   */
  private assertOidcClientBinding(
    claims: JWTPayload,
    expectedClient: string | undefined,
    purpose: "browser" | "invitation",
  ) {
    if (!expectedClient) {
      throw new UnauthorizedException("OIDC client ID is required");
    }
    const aud = Array.isArray(claims.aud) ? claims.aud
      : typeof claims.aud === "string" ? [claims.aud] : [];
    if (!aud.includes(expectedClient) ||
        (claims.azp !== undefined && claims.azp !== expectedClient) ||
        (claims.client_id !== undefined && claims.client_id !== expectedClient)) {
      // Log only fixed error code, flow and boolean comparison results;
      // never record client IDs, JWT claims, token bytes, or OAuth code.
      this.logger.warn(JSON.stringify({
        code: "OIDC_CLIENT_BINDING_MISMATCH",
        purpose,
        audienceMatched: aud.includes(expectedClient),
        azpPresent: claims.azp !== undefined,
        azpMatched: claims.azp === expectedClient,
        clientIdPresent: claims.client_id !== undefined,
        clientIdMatched: claims.client_id === expectedClient,
      }));
      throw new UnauthorizedException("OIDC token client does not match the login");
    }
    // A native Web token must not be repurposed for identity-only onboarding,
    // including a multi-audience token with no authorized-party claim.
    if (purpose === "invitation") {
      const nativeClients = [
        this.config.get<string>("OIDC_CLIENT_ID"),
        this.config.get<string>("OIDC_CLI_CLIENT_ID"),
      ].filter((value): value is string => Boolean(value));
      if (nativeClients.some((value) => aud.includes(value)) &&
          claims.azp !== expectedClient && claims.client_id !== expectedClient) {
        throw new UnauthorizedException("Ambiguous invitation token audience");
      }
    }
  }

  private async findServiceIdentity(subject: string) {
    const row = await this.prisma.serviceIdentity.findUnique({
      where: { zitadelUserId: subject },
      select: {
        id: true,
        tenantId: true,
        name: true,
        status: true,
        zitadelUserId: true,
        clientId: true,
      },
    });
    return row
      ? ({ ...row, status: row.status as ServiceIdentityRecord["status"] } satisfies ServiceIdentityRecord)
      : undefined;
  }

  private async findOrProvisionUser(
    issuer: string,
    payload: JWTPayload,
    identityProviderId?: string,
    allowInvitedProvision = false,
  ): Promise<AuthenticatedUser> {
    const subject = this.requireStringClaim(payload.sub, "sub");
    const email = this.getEmail(payload);
    const displayName = this.getDisplayName(payload, email);
    const providerType = this.config.get<string>("OIDC_PROVIDER_TYPE", "zitadel");
    const verificationStatus =
      payload.email_verified === true ? UserStatus.Active : UserStatus.Pending;
    const now = new Date();

    const existingIdentity = await this.prisma.userIdentity.findUnique({
      where: {
        issuer_externalSubject: {
          issuer,
          externalSubject: subject,
        },
      },
      include: { user: true },
    });

    if (existingIdentity) {
      if (existingIdentity.user.email !== email) {
        const emailOwner = await this.prisma.user.findUnique({
          where: { email },
          select: { id: true },
        });
        if (emailOwner && emailOwner.id !== existingIdentity.userId) {
          throw new UnauthorizedException("OIDC email belongs to another user");
        }
      }

      const status =
        existingIdentity.user.status === UserStatus.Suspended
          ? UserStatus.Suspended
          : verificationStatus;

      return this.prisma.user.update({
        where: { id: existingIdentity.userId },
        data: {
          email,
          displayName,
          status,
          identities: {
            update: {
              where: { id: existingIdentity.id },
              data: {
                email,
                lastLoginAt: now,
                ...(identityProviderId
                  ? { identityProvider: { connect: { id: identityProviderId } } }
                  : {}),
              },
            },
          },
        },
        select: {
          id: true,
          email: true,
          displayName: true,
          status: true,
        },
      });
    }

    const userByEmail = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (userByEmail) {
      throw new UnauthorizedException(
        "OIDC identity is not linked to the existing user account",
      );
    }

    if (!this.isAutoProvisionEnabled() && !allowInvitedProvision) {
      throw new UnauthorizedException("OIDC user is not provisioned");
    }

    return this.prisma.user.create({
      data: {
        email,
        displayName,
        status: verificationStatus,
        identities: {
          create: {
            providerType,
            issuer,
            externalSubject: subject,
            email,
            lastLoginAt: now,
            ...(identityProviderId
              ? { identityProvider: { connect: { id: identityProviderId } } }
              : {}),
          },
        },
      },
      select: {
        id: true,
        email: true,
        displayName: true,
        status: true,
      },
    });
  }

  private async getJwks(): Promise<RemoteJWKSet> {
    if (!this.jwks) {
      const { createRemoteJWKSet, customFetch } = await import("jose");
      const discovery = await this.getDiscovery();
      this.transport().assertIssuerEndpoint(discovery.jwksUri, "jwks");
      this.jwks = createRemoteJWKSet(new URL(discovery.jwksUri), {
        [customFetch]: async (url: string, options: { headers: Headers; method: "GET"; redirect: "manual"; signal: AbortSignal }) => {
          const response = await this.transport().fetch(url, "jwks", options);
          // HTTP 5xx/4xx from the identity service are availability failures,
          // never evidence that a cryptographically valid token is invalid.
          if (!response.ok) {
            throw new ServiceUnavailableException("OIDC JWKS endpoint is unavailable");
          }
          return response;
        },
      });
    }
    return this.jwks;
  }

  async getDiscovery(): Promise<OidcDiscovery> {
    if (this.discovery) return this.discovery;
    this.discoveryPromise ??= this.fetchDiscovery();
    try {
      this.discovery = await this.discoveryPromise;
      return this.discovery;
    } catch (error) {
      // A transient IdP outage must not permanently poison discovery until restart.
      this.discoveryPromise = undefined;
      throw error;
    }
  }

  private async fetchDiscovery(): Promise<OidcDiscovery> {
    const issuer = this.getIssuer();
    const response = await this.transport().fetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`, "discovery", {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new ServiceUnavailableException("OIDC discovery document is unavailable");
    }

    let discovery: Record<string, unknown>;
    try {
      discovery = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new ServiceUnavailableException("OIDC discovery document is malformed");
    }
    const discoveredIssuer = discovery.issuer;
    if (discoveredIssuer !== issuer) {
      throw new UnauthorizedException("OIDC discovery issuer mismatch");
    }
    const authorizationEndpoint = discovery.authorization_endpoint;
    const jwksUri = discovery.jwks_uri;
    const tokenEndpoint = discovery.token_endpoint;
    const registrationEndpoint = discovery.registration_endpoint;
    const deviceAuthorizationEndpoint = discovery.device_authorization_endpoint;
    const userInfoEndpoint = discovery.userinfo_endpoint;
    const revocationEndpoint = discovery.revocation_endpoint;
    const introspectionEndpoint = discovery.introspection_endpoint;
    const endSessionEndpoint = discovery.end_session_endpoint;
    const scopesSupported = stringArray(discovery.scopes_supported);
    const responseTypesSupported = stringArray(discovery.response_types_supported);
    const responseModesSupported = stringArray(discovery.response_modes_supported);
    const grantTypesSupported = stringArray(discovery.grant_types_supported);
    const tokenEndpointAuthMethodsSupported = stringArray(
      discovery.token_endpoint_auth_methods_supported,
    );
    const codeChallengeMethodsSupported = stringArray(
      discovery.code_challenge_methods_supported,
    );
    const authorizationResponseIssParameterSupported =
      discovery.authorization_response_iss_parameter_supported === true;

    if (typeof discoveredIssuer === "string" && discoveredIssuer !== issuer) {
      throw new UnauthorizedException("OIDC issuer mismatch");
    }
    if (typeof jwksUri !== "string" || jwksUri.length === 0) {
      throw new UnauthorizedException("OIDC discovery document misses jwks_uri");
    }
    if (typeof authorizationEndpoint !== "string" || authorizationEndpoint.length === 0) {
      throw new UnauthorizedException("OIDC discovery document misses authorization_endpoint");
    }
    if (typeof tokenEndpoint !== "string" || tokenEndpoint.length === 0) {
      throw new UnauthorizedException("OIDC discovery document misses token_endpoint");
    }

    for (const [url, stage] of [
      [authorizationEndpoint, "discovery"],
      [jwksUri, "jwks"],
      [tokenEndpoint, "code-exchange"],
    ] as const) this.transport().assertIssuerEndpoint(url, stage);
    for (const optional of [
      registrationEndpoint, deviceAuthorizationEndpoint, userInfoEndpoint,
      revocationEndpoint, introspectionEndpoint, endSessionEndpoint,
    ]) if (typeof optional === "string" && optional) {
      this.transport().assertIssuerEndpoint(optional, "discovery");
    }

    return {
      authorizationEndpoint,
      issuer,
      jwksUri,
      tokenEndpoint,
      registrationEndpoint:
        typeof registrationEndpoint === "string" && registrationEndpoint.length > 0
          ? registrationEndpoint
          : undefined,
      deviceAuthorizationEndpoint:
        typeof deviceAuthorizationEndpoint === "string" &&
        deviceAuthorizationEndpoint.length > 0
          ? deviceAuthorizationEndpoint
          : undefined,
      userInfoEndpoint:
        typeof userInfoEndpoint === "string" && userInfoEndpoint.length > 0
          ? userInfoEndpoint
          : undefined,
      revocationEndpoint:
        typeof revocationEndpoint === "string" && revocationEndpoint.length > 0
          ? revocationEndpoint
          : undefined,
      introspectionEndpoint:
        typeof introspectionEndpoint === "string" && introspectionEndpoint.length > 0
          ? introspectionEndpoint
          : undefined,
      scopesSupported,
      responseTypesSupported,
      responseModesSupported,
      grantTypesSupported,
      tokenEndpointAuthMethodsSupported,
      codeChallengeMethodsSupported,
      authorizationResponseIssParameterSupported,
      endSessionEndpoint:
        typeof endSessionEndpoint === "string" && endSessionEndpoint.length > 0
          ? endSessionEndpoint
          : undefined,
    };
  }

  private getIssuer() {
    const issuer = this.config.get<string>("OIDC_ISSUER_URL");
    if (!issuer) throw new UnauthorizedException("OIDC_ISSUER_URL is required");
    return issuer.replace(/\/$/, "");
  }

  private getAudience() {
    const audience = this.config.get<string>("OIDC_AUDIENCE");
    const clientId = this.config.get<string>("OIDC_CLIENT_ID");
    const projectId = this.config.get<string>("ZITADEL_PROJECT_ID");
    return [...new Set([...(audience || clientId || "").split(","), projectId ?? ""])]
      .map((item) => item.trim())
      .filter(Boolean);
  }

  private assertMcpTokenClaims(payload: JWTPayload) {
    const projectId = this.config.get<string>("ZITADEL_PROJECT_ID")?.trim();
    if (!projectId) {
      throw new UnauthorizedException("ZITADEL_PROJECT_ID is required for MCP authentication");
    }

    const audience = Array.isArray(payload.aud)
      ? payload.aud
      : typeof payload.aud === "string"
        ? [payload.aud]
        : [];
    if (!audience.includes(projectId)) {
      throw new UnauthorizedException("MCP bearer token is missing the ResourcePortal project audience");
    }
  }

  private getEmail(payload: JWTPayload) {
    const email = payload.email;
    if (typeof email !== "string" || email.length === 0) {
      throw new UnauthorizedException("OIDC email claim is required");
    }
    return email.toLowerCase();
  }

  private getDisplayName(payload: JWTPayload, email: string) {
    const name = payload.name;
    const preferredUsername = payload.preferred_username;
    if (typeof name === "string" && name.length > 0) return name;
    if (typeof preferredUsername === "string" && preferredUsername.length > 0) {
      return preferredUsername;
    }
    return email;
  }

  private isAutoProvisionEnabled() {
    return this.config.get<string>("OIDC_AUTO_PROVISION_USERS", "true").toLowerCase() !== "false";
  }

  private requireStringClaim(value: unknown, claimName: string) {
    if (typeof value !== "string" || value.length === 0) {
      throw new UnauthorizedException(`OIDC ${claimName} claim is required`);
    }
    return value;
  }
}

function stringArray(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
  return values.length > 0 ? values : undefined;
}
