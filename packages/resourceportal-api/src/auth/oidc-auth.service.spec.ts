import { ConfigService } from "@nestjs/config";
import { UserStatus } from "@prisma/client";
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
} from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import { OidcAuthService } from "./oidc-auth.service";

type ConfigValues = Record<string, string | undefined>;

function createConfig(values: ConfigValues) {
  return {
    get: <T = string>(key: string, defaultValue?: T) =>
      (values[key] ?? defaultValue) as T,
  } as ConfigService;
}

async function createTokenFixture(
  emailVerified = true,
  includeEmail = true,
  authenticatedIdpId?: string,
  nonce?: string,
  clientClaims?: { audience?: string | string[]; azp?: string; client_id?: string },
  subjectId = "zitadel-user-1",
  omitVerifiedEmail = false,
) {
  const issuer = "https://issuer.example.com";
  const audience = "resource-portal";
  const subject = subjectId;
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  const keyId = "test-key";
  publicJwk.kid = keyId;
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";

  const token = await new SignJWT({
    ...(includeEmail ? { email: "User@Example.com" } : {}),
    ...(omitVerifiedEmail ? {} : { email_verified: emailVerified }),
    name: "Example User",
    ...(nonce ? { nonce } : {}),
    ...(clientClaims?.azp ? { azp: clientClaims.azp } : {}),
    ...(clientClaims?.client_id ? { client_id: clientClaims.client_id } : {}),
    ...(authenticatedIdpId ? { "urn:resourceportal:auth:external_idp_id": authenticatedIdpId } : {}),
  })
    .setProtectedHeader({
      alg: "RS256",
      kid: keyId,
    })
    .setIssuer(issuer)
    .setAudience(clientClaims?.audience ?? audience)
    .setSubject(subject)
    .setExpirationTime("5m")
    .sign(privateKey);

  return {
    audience,
    issuer,
    jwksUri: `${issuer}/oauth/v2/keys`,
    publicJwk,
    subject,
    token,
  };
}

function requestUrl(input: string | URL | Request) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function installOidcFetch(
  fixture: Awaited<ReturnType<typeof createTokenFixture>>,
  userInfo?: Record<string, unknown>,
) {
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      void init;
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      if (url === `${fixture.issuer}/.well-known/openid-configuration`) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              issuer: fixture.issuer,
              authorization_endpoint: `${fixture.issuer}/oauth/v2/authorize`,
              token_endpoint: `${fixture.issuer}/oauth/v2/token`,
              registration_endpoint: `${fixture.issuer}/oauth/v2/register`,
              device_authorization_endpoint: `${fixture.issuer}/oauth/v2/device_authorization`,
              userinfo_endpoint: `${fixture.issuer}/oidc/v1/userinfo`,
              revocation_endpoint: `${fixture.issuer}/oauth/v2/revoke`,
              introspection_endpoint: `${fixture.issuer}/oauth/v2/introspect`,
              end_session_endpoint: `${fixture.issuer}/oidc/v1/end_session`,
              scopes_supported: ["openid", "profile", "email", "offline_access"],
              response_types_supported: ["code"],
              response_modes_supported: ["query", "form_post"],
              grant_types_supported: ["authorization_code", "refresh_token"],
              token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
              code_challenge_methods_supported: ["S256"],
              jwks_uri: fixture.jwksUri,
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          ),
        );
      }

      if (url === `${fixture.issuer}/oidc/v1/userinfo` && userInfo) {
        return Promise.resolve(
          new Response(JSON.stringify(userInfo), {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          }),
        );
      }

      if (url === fixture.jwksUri) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              keys: [fixture.publicJwk],
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          ),
        );
      }

      return Promise.resolve(
        new Response("not found", {
          status: 404,
        }),
      );
    });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("OidcAuthService", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("classifies a temporary JWKS HTTP outage as 503, never an invalid bearer credential", async () => {
    const fixture = await createTokenFixture();
    const successfulFetch = installOidcFetch(fixture);
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) =>
      requestUrl(input) === fixture.jwksUri
        ? Promise.resolve(new Response("temporarily unavailable", { status: 503 }))
        : successfulFetch(input, init),
    ));
    const service = new OidcAuthService(
      createConfig({ OIDC_ISSUER_URL: fixture.issuer, OIDC_CLIENT_ID: fixture.audience }),
      {} as PrismaService,
    );
    await expect(service.authenticateBearerToken(fixture.token))
      .rejects.toMatchObject({ status: 503 });
  });

  it("classifies malformed OIDC discovery as service unavailability instead of raw 500", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{ malformed-json", { status: 200 })));
    const service = new OidcAuthService(
      createConfig({ OIDC_ISSUER_URL: "https://issuer.example.com" }),
      {} as PrismaService,
    );
    await expect(service.getDiscovery()).rejects.toMatchObject({ status: 503 });
  });

  it("exposes optional device authorization and userinfo discovery endpoints", async () => {
    const fixture = await createTokenFixture();
    installOidcFetch(fixture);
    const service = new OidcAuthService(
      createConfig({
        OIDC_ISSUER_URL: fixture.issuer,
        OIDC_CLIENT_ID: fixture.audience,
      }),
      {} as PrismaService,
    );

    await expect(service.getDiscovery()).resolves.toMatchObject({
      registrationEndpoint: `${fixture.issuer}/oauth/v2/register`,
      deviceAuthorizationEndpoint: `${fixture.issuer}/oauth/v2/device_authorization`,
      userInfoEndpoint: `${fixture.issuer}/oidc/v1/userinfo`,
      introspectionEndpoint: `${fixture.issuer}/oauth/v2/introspect`,
      codeChallengeMethodsSupported: ["S256"],
      tokenEndpointAuthMethodsSupported: ["none", "client_secret_basic"],
    });
  });

  it("uses UserInfo for browser login when the verified ID token omits email", async () => {
    const fixture = await createTokenFixture(true, false);
    const prisma = {
      userIdentity: { findUnique: vi.fn().mockResolvedValue(null) },
      user: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({
          id: "user-1",
          email: "patryk@example.test",
          displayName: "Patryk",
          status: UserStatus.Active,
        }),
      },
    };
    const fetchMock = installOidcFetch(fixture, {
      sub: fixture.subject,
      email: "patryk@example.test",
      email_verified: true,
      name: "Patryk",
    });
    const service = new OidcAuthService(
      createConfig({
        OIDC_ISSUER_URL: fixture.issuer,
        OIDC_CLIENT_ID: fixture.audience,
        OIDC_PROVIDER_TYPE: "zitadel",
      }),
      prisma as unknown as PrismaService,
    );

    const user = await service.authenticateBrowserTokens(
      fixture.token,
      "browser-access-token",
    );

    expect(user).toMatchObject({
      email: "patryk@example.test",
      displayName: "Patryk",
      status: UserStatus.Active,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      fixture.issuer + "/oidc/v1/userinfo",
      expect.objectContaining({
        headers: { authorization: "Bearer browser-access-token" },
      }),
    );
  });

  it("rejects browser UserInfo when its subject does not match the verified ID token", async () => {
    const fixture = await createTokenFixture(true, false);
    const fetchMock = installOidcFetch(fixture, {
      sub: "different-subject",
      email: "patryk@example.test",
      email_verified: true,
    });
    const service = new OidcAuthService(
      createConfig({
        OIDC_ISSUER_URL: fixture.issuer,
        OIDC_CLIENT_ID: fixture.audience,
      }),
      {} as PrismaService,
    );

    await expect(
      service.authenticateBrowserTokens(fixture.token, "browser-access-token"),
    ).rejects.toThrow("OIDC UserInfo subject mismatch");
    expect(fetchMock).toHaveBeenCalledWith(
      fixture.issuer + "/oidc/v1/userinfo",
      expect.objectContaining({
        headers: { authorization: "Bearer browser-access-token" },
      }),
    );
  });

  it("uses UserInfo when a verified human access token omits email", async () => {
    const fixture = await createTokenFixture(true, false);
    const prisma = {
      serviceIdentity: { findUnique: vi.fn().mockResolvedValue(null) },
      userIdentity: { findUnique: vi.fn().mockResolvedValue(null) },
      user: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({
          id: "user-1",
          email: "patryk@example.test",
          displayName: "Patryk",
          status: UserStatus.Active,
        }),
      },
    };
    const fetchMock = installOidcFetch(fixture, {
      sub: fixture.subject,
      email: "patryk@example.test",
      email_verified: true,
      name: "Patryk",
    });
    const service = new OidcAuthService(
      createConfig({
        OIDC_ISSUER_URL: fixture.issuer,
        OIDC_CLIENT_ID: fixture.audience,
        OIDC_PROVIDER_TYPE: "zitadel",
      }),
      prisma as unknown as PrismaService,
    );

    const principal = await service.authenticatePrincipalToken(fixture.token);

    expect(principal).toMatchObject({
      type: "User",
      user: { email: "patryk@example.test" },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `${fixture.issuer}/oidc/v1/userinfo`,
      expect.objectContaining({
        headers: { authorization: `Bearer ${fixture.token}` },
      }),
    );
  });

  it.each(["new", "existing"])("rejects attested external bearer before %s user writes", async (scenario) => {
    const fixture = await createTokenFixture(true, true, "external-zitadel-idp");
    const prisma = {
      serviceIdentity: { findUnique: vi.fn().mockResolvedValue(null) },
      userIdentity: { findUnique: vi.fn().mockResolvedValue(scenario === "existing" ? { id: "existing-identity" } : null) },
      user: {
        findUnique: vi.fn(), create: vi.fn(), update: vi.fn(),
      },
    };
    const fetchMock = installOidcFetch(fixture);
    const service = new OidcAuthService(createConfig({
      OIDC_ISSUER_URL: fixture.issuer,
      OIDC_CLIENT_ID: fixture.audience,
    }), prisma as unknown as PrismaService);
    await expect(service.authenticatePrincipalToken(fixture.token, true))
      .rejects.toThrow("External identity provider login is disabled");
    expect(prisma.userIdentity.findUnique).not.toHaveBeenCalled();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([input]) => requestUrl(input).endsWith("/oidc/v1/userinfo")))
      .toHaveLength(0);
  });

  it("rejects attested external browser callback before any user or identity mutation", async () => {
    const fixture = await createTokenFixture(true, true, "external-zitadel-idp");
    const prisma = {
      userIdentity: { findUnique: vi.fn() },
      user: { create: vi.fn(), update: vi.fn() },
    };
    installOidcFetch(fixture);
    const service = new OidcAuthService(createConfig({
      OIDC_ISSUER_URL: fixture.issuer,
      OIDC_CLIENT_ID: fixture.audience,
    }), prisma as unknown as PrismaService);
    await expect(service.authenticateBrowserTokens(fixture.token, "access", undefined, undefined, true))
      .rejects.toThrow("External identity provider login is disabled");
    expect(prisma.userIdentity.findUnique).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("accepts an MCP token carrying the ResourcePortal project audience", async () => {
    const fixture = await createTokenFixture(true, false);
    const prisma = {
      serviceIdentity: {
        findUnique: vi.fn().mockResolvedValue({
          id: "service-1",
          tenantId: "tenant-1",
          name: "mcp-test",
          status: "Active",
          zitadelUserId: fixture.subject,
          clientId: "rp-si-service-1",
        }),
      },
    };
    installOidcFetch(fixture);
    const service = new OidcAuthService(
      createConfig({
        OIDC_ISSUER_URL: fixture.issuer,
        OIDC_CLIENT_ID: fixture.audience,
        ZITADEL_PROJECT_ID: fixture.audience,
      }),
      prisma as unknown as PrismaService,
    );

    await expect(service.authenticateMcpPrincipalToken(fixture.token)).resolves.toMatchObject({
      type: "ServiceIdentity",
      serviceIdentity: { id: "service-1" },
    });
  });

  it("rejects an MCP token that lacks the ResourcePortal project audience", async () => {
    const fixture = await createTokenFixture();
    installOidcFetch(fixture);
    const service = new OidcAuthService(
      createConfig({
        OIDC_ISSUER_URL: fixture.issuer,
        OIDC_CLIENT_ID: fixture.audience,
        ZITADEL_PROJECT_ID: "zitadel-project-1",
      }),
      {} as PrismaService,
    );

    await expect(service.authenticateMcpPrincipalToken(fixture.token)).rejects.toThrow(
      "MCP bearer token is missing the ResourcePortal project audience",
    );
  });

  it("rejects UserInfo subject mismatch", async () => {
    const fixture = await createTokenFixture(true, false);
    const prisma = {
      serviceIdentity: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    installOidcFetch(fixture, {
      sub: "different-subject",
      email: "patryk@example.test",
      email_verified: true,
    });
    const service = new OidcAuthService(
      createConfig({
        OIDC_ISSUER_URL: fixture.issuer,
        OIDC_CLIENT_ID: fixture.audience,
      }),
      prisma as unknown as PrismaService,
    );

    await expect(service.authenticatePrincipalToken(fixture.token)).rejects.toThrow(
      "OIDC UserInfo subject mismatch",
    );
  });

  it("does not call UserInfo for an invalid JWT", async () => {
    const fixture = await createTokenFixture(true, false);
    const prisma = { $queryRaw: vi.fn() };
    const fetchMock = installOidcFetch(fixture, {
      sub: fixture.subject,
      email: "patryk@example.test",
    });
    const service = new OidcAuthService(
      createConfig({
        OIDC_ISSUER_URL: fixture.issuer,
        OIDC_CLIENT_ID: fixture.audience,
      }),
      prisma as unknown as PrismaService,
    );

    await expect(service.authenticatePrincipalToken("bad-token")).rejects.toThrow(
      "OIDC bearer token is invalid",
    );
    expect(
      fetchMock.mock.calls.filter(([input]) => requestUrl(input).endsWith("/oidc/v1/userinfo")),
    ).toHaveLength(0);
  });

  it("keeps service identity bearer authentication independent of UserInfo", async () => {
    const fixture = await createTokenFixture(true, false);
    const prisma = {
      serviceIdentity: {
        findUnique: vi.fn().mockResolvedValue({
          id: "service-1",
          tenantId: "tenant-1",
          name: "cli",
          status: "Active",
          zitadelUserId: fixture.subject,
          clientId: "rp-si-service-1",
        }),
      },
    };
    const fetchMock = installOidcFetch(fixture, {
      sub: fixture.subject,
      email: "should-not-be-used@example.test",
    });
    const service = new OidcAuthService(
      createConfig({
        OIDC_ISSUER_URL: fixture.issuer,
        OIDC_CLIENT_ID: fixture.audience,
      }),
      prisma as unknown as PrismaService,
    );

    const principal = await service.authenticatePrincipalToken(fixture.token);

    expect(principal).toMatchObject({
      type: "ServiceIdentity",
      serviceIdentity: { id: "service-1" },
    });
    expect(
      fetchMock.mock.calls.filter(([input]) => requestUrl(input).endsWith("/oidc/v1/userinfo")),
    ).toHaveLength(0);
  });

  it("verifies an OIDC token and auto-provisions a verified user identity", async () => {
    const fixture = await createTokenFixture();
    const prisma = {
      userIdentity: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
      user: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({
          id: "31af4f62-2897-4181-965d-176728ad2e36",
          email: "user@example.com",
          displayName: "Example User",
          status: UserStatus.Active,
        }),
      },
    };
    installOidcFetch(fixture);

    const service = new OidcAuthService(
      createConfig({
        OIDC_ISSUER_URL: fixture.issuer,
        OIDC_CLIENT_ID: fixture.audience,
        OIDC_PROVIDER_TYPE: "zitadel",
      }),
      prisma as unknown as PrismaService,
    );

    const user = await service.authenticateBearerToken(fixture.token);

    expect(user).toEqual({
      id: "31af4f62-2897-4181-965d-176728ad2e36",
      email: "user@example.com",
      displayName: "Example User",
      status: UserStatus.Active,
    });
    expect(prisma.user.create).toHaveBeenCalledWith({
      data: {
        email: "user@example.com",
        displayName: "Example User",
        status: UserStatus.Active,
        identities: {
          create: {
            providerType: "zitadel",
            issuer: fixture.issuer,
            externalSubject: fixture.subject,
            email: "user@example.com",
            lastLoginAt: expect.any(Date) as Date,
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
  });

  it("provisions an unverified OIDC user as Pending", async () => {
    const fixture = await createTokenFixture(false);
    const prisma = {
      userIdentity: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
      user: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({
          id: "31af4f62-2897-4181-965d-176728ad2e36",
          email: "user@example.com",
          displayName: "Example User",
          status: UserStatus.Pending,
        }),
      },
    };
    installOidcFetch(fixture);

    const service = new OidcAuthService(
      createConfig({
        OIDC_ISSUER_URL: fixture.issuer,
        OIDC_CLIENT_ID: fixture.audience,
        OIDC_PROVIDER_TYPE: "zitadel",
      }),
      prisma as unknown as PrismaService,
    );

    await expect(service.authenticateBearerToken(fixture.token)).resolves.toMatchObject({
      status: UserStatus.Pending,
    });
    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: UserStatus.Pending,
        }) as unknown,
      }),
    );
  });

  it("does not link a new OIDC identity to an existing user by email alone", async () => {
    const fixture = await createTokenFixture();
    const prisma = {
      userIdentity: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
      user: {
        findUnique: vi.fn().mockResolvedValue({ id: "existing-user" }),
        create: vi.fn(),
        update: vi.fn(),
      },
    };
    installOidcFetch(fixture);

    const service = new OidcAuthService(
      createConfig({
        OIDC_ISSUER_URL: fixture.issuer,
        OIDC_CLIENT_ID: fixture.audience,
        OIDC_PROVIDER_TYPE: "zitadel",
      }),
      prisma as unknown as PrismaService,
    );

    await expect(service.authenticateBearerToken(fixture.token)).rejects.toThrow(
      "OIDC identity is not linked to the existing user account",
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it("reads provider logout and revocation endpoints from discovery", async () => {
    const fixture = await createTokenFixture();
    const prisma = {
      userIdentity: { findUnique: vi.fn() },
      user: { findUnique: vi.fn() },
    };
    installOidcFetch(fixture);
    const service = new OidcAuthService(
      createConfig({ OIDC_ISSUER_URL: fixture.issuer }),
      prisma as unknown as PrismaService,
    );

    await expect(service.getDiscovery()).resolves.toMatchObject({
      revocationEndpoint: `${fixture.issuer}/oauth/v2/revoke`,
      endSessionEndpoint: `${fixture.issuer}/oidc/v1/end_session`,
    });
  });
});

describe("signed tenant IdP provenance and bounded OIDC provider I/O (#238, #215)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects a selected provider cookie if the signed ID token has no matching authentication provenance", async () => {
    const fixture = await createTokenFixture();
    installOidcFetch(fixture);
    const prisma = {
      identityProvider: { findUnique: vi.fn().mockResolvedValue({
        enabled: true, zitadelIdentityProviderId: "external-idp-42",
      }) },
      userIdentity: { findUnique: vi.fn() },
    };
    const service = new OidcAuthService(
      createConfig({ OIDC_ISSUER_URL: fixture.issuer, OIDC_CLIENT_ID: fixture.audience }),
      prisma as unknown as PrismaService,
    );
    await expect(service.authenticateBrowserTokens(fixture.token, "browser-access", "selected-provider-row"))
      .rejects.toThrow("Selected external identity provider was not verified");
    expect(prisma.userIdentity.findUnique).not.toHaveBeenCalled();
  });

  it("accepts selected provider only when issuer-signed claim equals its actual Zitadel provider identity", async () => {
    const fixture = await createTokenFixture(true, true, "external-idp-42");
    installOidcFetch(fixture);
    const user = { id: "user-1", email: "user@example.com", displayName: "Example User", status: UserStatus.Active };
    const prisma = {
      identityProvider: { findUnique: vi.fn().mockResolvedValue({
        enabled: true, zitadelIdentityProviderId: "external-idp-42",
      }) },
      userIdentity: { findUnique: vi.fn().mockResolvedValue({
        id: "identity-1", userId: "user-1", user,
      }) },
      user: { update: vi.fn().mockResolvedValue(user) },
    };
    const service = new OidcAuthService(
      createConfig({ OIDC_ISSUER_URL: fixture.issuer, OIDC_CLIENT_ID: fixture.audience }),
      prisma as unknown as PrismaService,
    );
    await expect(service.authenticateBrowserTokens(fixture.token, "browser-access", "selected-provider-row"))
      .resolves.toEqual({ ...user, authenticatedIdpId: "external-idp-42" });
    expect(prisma.user.update).toHaveBeenCalledOnce();
  });

  it("attaches an AbortSignal to OIDC discovery and UserInfo network operations", async () => {
    const fixture = await createTokenFixture(true, false);
    const fetchMock = installOidcFetch(fixture, {
      sub: fixture.subject, email: "person@example.com", email_verified: true,
    });
    const user = { id: "user-1", email: "person@example.com", status: UserStatus.Active };
    const prisma = {
      userIdentity: { findUnique: vi.fn().mockResolvedValue(null) },
      user: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue(user) },
    };
    const service = new OidcAuthService(
      createConfig({ OIDC_ISSUER_URL: fixture.issuer, OIDC_CLIENT_ID: fixture.audience }),
      prisma as unknown as PrismaService,
    );
    await service.authenticateBrowserTokens(fixture.token, "browser-access");
    const providerCalls = fetchMock.mock.calls.filter(([input]) =>
      /openid-configuration|userinfo/.test(requestUrl(input)),
    );
    expect(providerCalls).toHaveLength(2);
    for (const [, init] of providerCalls) expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("server-attested external IdP authentication (#238)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("accepts issuer-signed ID token plus one-time matching backend evidence", async () => {
    const fixture = await createTokenFixture();
    installOidcFetch(fixture);
    const user = { id: "user-1", email: "user@example.com",
      displayName: "Example User", status: UserStatus.Active };
    const prisma = {
      identityProvider: { findUnique: vi.fn().mockResolvedValue({
        enabled: true, zitadelIdentityProviderId: "zitadel-real-idp",
      }) },
      userIdentity: { findUnique: vi.fn().mockResolvedValue({
        id: "identity-1", userId: "user-1", user,
      }) },
      user: { update: vi.fn().mockResolvedValue(user) },
    };
    const proof = { consume: vi.fn().mockResolvedValue(true) };
    const service = new OidcAuthService(
      createConfig({ OIDC_ISSUER_URL: fixture.issuer, OIDC_CLIENT_ID: fixture.audience }),
      prisma as unknown as PrismaService,
      proof as unknown as import("./federation-proof.service").FederationProofService,
    );
    await expect(service.authenticateBrowserTokens(
      fixture.token, "browser-access", "rp-provider-id", "A".repeat(43),
    )).resolves.toEqual({ ...user, authenticatedIdpId: "zitadel-real-idp" });
    expect(proof.consume).toHaveBeenCalledWith("A".repeat(43), "zitadel-real-idp");
  });

  it("rejects a mismatching IdP event even with a valid signed OIDC token", async () => {
    const fixture = await createTokenFixture();
    installOidcFetch(fixture);
    const prisma = {
      identityProvider: { findUnique: vi.fn().mockResolvedValue({
        enabled: true, zitadelIdentityProviderId: "required-idp",
      }) },
      userIdentity: { findUnique: vi.fn() },
    };
    const proof = { consume: vi.fn().mockResolvedValue(false) };
    const service = new OidcAuthService(
      createConfig({ OIDC_ISSUER_URL: fixture.issuer, OIDC_CLIENT_ID: fixture.audience }),
      prisma as unknown as PrismaService,
      proof as unknown as import("./federation-proof.service").FederationProofService,
    );
    await expect(service.authenticateBrowserTokens(
      fixture.token, "browser-access", "rp-provider-id", "A".repeat(43),
    )).rejects.toThrow("Selected external identity provider was not verified");
    expect(prisma.userIdentity.findUnique).not.toHaveBeenCalled();
  });
});

describe("#430 onboarding ID tokens cannot authorize ordinary RP API or link unrelated subjects", () => {
  afterEach(() => vi.unstubAllGlobals());

  const config = (issuer: string, inviteAudience: string) => createConfig({
    OIDC_ISSUER_URL: issuer,
    OIDC_INVITATION_CLIENT_ID: inviteAudience,
    RP_INVITATION_ONBOARDING_ENABLED: "true",
    OIDC_CLIENT_ID: "regular-rp-web-client",
    OIDC_CLI_CLIENT_ID: "regular-rp-cli-client",
    OIDC_AUDIENCE: "regular-rp-web-client",
    OIDC_AUTO_PROVISION_USERS: "false",
  });

  it("verifies a signed invite-client-specific ID token and nonce, then provisions only the invited subject", async () => {
    const nonce = "N".repeat(43);
    const fixture = await createTokenFixture(true, true, undefined, nonce);
    installOidcFetch(fixture);
    const user = { id: "new-user", email: "user@example.com", displayName: "Example User", status: UserStatus.Active };
    const prisma = {
      userIdentity: { findUnique: vi.fn().mockResolvedValue(null) },
      user: { findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(user) },
    };
    const service = new OidcAuthService(config(fixture.issuer, fixture.audience), prisma as unknown as PrismaService);
    expect(await service.authenticateInvitationTokens(fixture.token, "identity-only-access", nonce, "user@example.com"))
      .toEqual(user);
    expect(prisma.user.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        email: "user@example.com",
        identities: { create: expect.objectContaining({
          issuer: fixture.issuer, externalSubject: fixture.subject,
        }) as unknown },
      }) as unknown,
    }));
    expect(prisma.user.create).toHaveBeenCalledOnce();
  });

  it("accepts a real Web authorization-code ID token with multi-audience invite entry and Web authorized party", async () => {
    const web = "regular-rp-web-client";
    const invite = "identity-only-invitation-client";
    const fixture = await createTokenFixture(true, true, undefined, undefined, {
      audience: [web, invite, "zitadel-project"], azp: web, client_id: web,
    });
    installOidcFetch(fixture);
    const user = { id: "user-1", email: "user@example.com", displayName: "Example User", status: UserStatus.Active };
    const prisma = {
      userIdentity: { findUnique: vi.fn().mockResolvedValue({ id: "identity-1", userId: user.id, user }) },
      user: { update: vi.fn().mockResolvedValue(user) },
    };
    const service = new OidcAuthService(createConfig({
      OIDC_ISSUER_URL: fixture.issuer, OIDC_CLIENT_ID: web,
      OIDC_CLI_CLIENT_ID: "regular-rp-cli-client",
      OIDC_AUDIENCE: web, ZITADEL_PROJECT_ID: "zitadel-project",
      OIDC_INVITATION_CLIENT_ID: invite, RP_INVITATION_ONBOARDING_ENABLED: "true",
    }), prisma as unknown as PrismaService);
    await expect(service.authenticateBrowserTokens(fixture.token, "access")).resolves.toMatchObject(user);
    expect(prisma.user.update).toHaveBeenCalledOnce();
  });

  it.each([
    { label: "authorized party", azp: "identity-only-invitation-client", client_id: "regular-rp-web-client" },
    { label: "client_id", azp: "regular-rp-web-client", client_id: "identity-only-invitation-client" },
  ])("rejects a multi-audience token attributed to invitation by $label even with native audience", async ({ azp, client_id }) => {
    const web = "regular-rp-web-client";
    const invite = "identity-only-invitation-client";
    const fixture = await createTokenFixture(true, true, undefined, undefined, {
      audience: [web, invite, "zitadel-project"], azp, client_id,
    });
    installOidcFetch(fixture);
    const prisma = { userIdentity: { findUnique: vi.fn() } };
    const service = new OidcAuthService(createConfig({
      OIDC_ISSUER_URL: fixture.issuer, OIDC_CLIENT_ID: web,
      OIDC_AUDIENCE: web, OIDC_INVITATION_CLIENT_ID: invite,
      RP_INVITATION_ONBOARDING_ENABLED: "true",
    }), prisma as unknown as PrismaService);
    await expect(service.authenticateBrowserTokens(fixture.token, "access"))
      .rejects.toThrow("OIDC bearer token is invalid");
    expect(prisma.userIdentity.findUnique).not.toHaveBeenCalled();
  });

  it("accepts multi-audience ZITADEL Web ID tokens without azp only after the Web client code+PKCE exchange", async () => {
    const web = "regular-rp-web-client";
    const invite = "identity-only-invitation-client";
    const fixture = await createTokenFixture(true, true, undefined, undefined, { audience: [web, invite] });
    installOidcFetch(fixture);
    const user = { id: "user-1", email: "user@example.com", displayName: "Example User", status: UserStatus.Active };
    const prisma = {
      userIdentity: { findUnique: vi.fn().mockResolvedValue({ id: "identity-1", userId: user.id, user }) },
      user: { update: vi.fn().mockResolvedValue(user) },
    };
    const service = new OidcAuthService(createConfig({
      OIDC_ISSUER_URL: fixture.issuer, OIDC_CLIENT_ID: web,
      OIDC_AUDIENCE: web, OIDC_INVITATION_CLIENT_ID: invite,
    }), prisma as unknown as PrismaService);
    await expect(service.authenticateBrowserTokens(fixture.token, "access", undefined, undefined, false, true))
      .resolves.toMatchObject(user);
    await expect(service.authenticateBearerToken(fixture.token))
      .rejects.toThrow("OIDC bearer token is invalid");
  });

  it("rejects an ambiguous signed multi-audience token without issued-client provenance", async () => {
    const web = "regular-rp-web-client";
    const invite = "identity-only-invitation-client";
    const fixture = await createTokenFixture(true, true, undefined, undefined, { audience: [web, invite] });
    installOidcFetch(fixture);
    const prisma = { userIdentity: { findUnique: vi.fn() } };
    const service = new OidcAuthService(createConfig({
      OIDC_ISSUER_URL: fixture.issuer, OIDC_CLIENT_ID: web,
      OIDC_AUDIENCE: web, OIDC_INVITATION_CLIENT_ID: invite,
    }), prisma as unknown as PrismaService);
    await expect(service.authenticateBrowserTokens(fixture.token, "access"))
      .rejects.toThrow("OIDC bearer token is invalid");
    expect(prisma.userIdentity.findUnique).not.toHaveBeenCalled();
  });

  it("requires the physical Web client audience, not just ZITADEL project, for browser login", async () => {
    const fixture = await createTokenFixture(true, true, undefined, undefined, {
      audience: ["zitadel-project"], azp: "another-application",
    });
    installOidcFetch(fixture);
    const prisma = { userIdentity: { findUnique: vi.fn() } };
    const service = new OidcAuthService(createConfig({
      OIDC_ISSUER_URL: fixture.issuer, OIDC_CLIENT_ID: "regular-rp-web-client",
      OIDC_AUDIENCE: "zitadel-project",
    }), prisma as unknown as PrismaService);
    await expect(service.authenticateBrowserTokens(fixture.token, "access"))
      .rejects.toThrow("OIDC token client does not match the login");
    expect(prisma.userIdentity.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a Web-origin multi-audience token as onboarding proof", async () => {
    const web = "regular-rp-web-client";
    const invite = "identity-only-invitation-client";
    const nonce = "N".repeat(43);
    const fixture = await createTokenFixture(true, true, undefined, nonce, {
      audience: [web, invite], azp: web,
    });
    installOidcFetch(fixture);
    const prisma = { userIdentity: { findUnique: vi.fn() } };
    const service = new OidcAuthService(createConfig({
      OIDC_ISSUER_URL: fixture.issuer, OIDC_CLIENT_ID: web,
      OIDC_CLI_CLIENT_ID: "regular-rp-cli-client",
      OIDC_INVITATION_CLIENT_ID: invite, RP_INVITATION_ONBOARDING_ENABLED: "true",
    }), prisma as unknown as PrismaService);
    await expect(service.authenticateInvitationTokens(fixture.token, "access", nonce, "user@example.com"))
      .rejects.toThrow("OIDC token client does not match the login");
    expect(prisma.userIdentity.findUnique).not.toHaveBeenCalled();
  });

  it("denies onboarding-client tokens on normal bearer API regardless of RP audience settings", async () => {
    const nonce = "N".repeat(43);
    const fixture = await createTokenFixture(true, true, undefined, nonce);
    installOidcFetch(fixture);
    const cfg = createConfig({
      OIDC_ISSUER_URL: fixture.issuer,
      OIDC_CLIENT_ID: "regular-rp-web-client",
      OIDC_AUDIENCE: fixture.audience,
      OIDC_INVITATION_CLIENT_ID: fixture.audience,
      RP_INVITATION_ONBOARDING_ENABLED: "true",
    });
    const prisma = { userIdentity: { findUnique: vi.fn() } };
    const service = new OidcAuthService(cfg, prisma as unknown as PrismaService);
    await expect(service.authenticateBearerToken(fixture.token))
      .rejects.toThrow("OIDC bearer token is invalid");
    expect(prisma.userIdentity.findUnique).not.toHaveBeenCalled();
  });

  it("rejects wrong nonce, wrong verified email, unverified email and native client confusion", async () => {
    const nonce = "N".repeat(43);
    const signed = await createTokenFixture(true, true, undefined, nonce);
    const unsignedEmail = await createTokenFixture(false, true, undefined, nonce);
    installOidcFetch(signed);
    const prisma = {
      userIdentity: { findUnique: vi.fn() },
      user: { findUnique: vi.fn(), create: vi.fn() },
    };
    const service = new OidcAuthService(config(signed.issuer, signed.audience), prisma as unknown as PrismaService);
    await expect(service.authenticateInvitationTokens(signed.token, "access", "wrong", "user@example.com"))
      .rejects.toThrow("Invitation identity proof is invalid");
    await expect(service.authenticateInvitationTokens(signed.token, "access", nonce, "other@example.com"))
      .rejects.toThrow("Verified invitation email mismatch");
    await expect(service.authenticateInvitationTokens(unsignedEmail.token, "access", nonce, "user@example.com"))
      .rejects.toThrow();
    expect(prisma.userIdentity.findUnique).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it("never links a second ZITADEL subject to an existing RP User based solely on email", async () => {
    const nonce = "N".repeat(43);
    const fixture = await createTokenFixture(true, true, undefined, nonce);
    installOidcFetch(fixture);
    const prisma = {
      userIdentity: { findUnique: vi.fn().mockResolvedValue(null) },
      user: { findUnique: vi.fn().mockResolvedValue({ id: "other-subject-user" }),
        create: vi.fn(), update: vi.fn() },
    };
    const service = new OidcAuthService(config(fixture.issuer, fixture.audience), prisma as unknown as PrismaService);
    await expect(service.authenticateInvitationTokens(fixture.token, "access", nonce, "user@example.com"))
      .rejects.toThrow("OIDC identity is not linked to the existing user account");
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});


describe("#442 signed isolated MCP-only identity proof without Web grant", () => {
  afterEach(() => vi.unstubAllGlobals());

  const nonce = "N".repeat(43);
  const client = "340396026519785524";
  const subject = "1234567890123";
  const user = {
    id: "00000000-0000-4000-8000-000000000123",
    email: "user@example.com",
    displayName: "MCP-only",
    status: UserStatus.Active,
  };

  function prepare(fixture: Awaited<ReturnType<typeof createTokenFixture>>,
      linked = true, userStatus: UserStatus = UserStatus.Active,
      userInfo?: Record<string, unknown>) {
    const fetchMock = installOidcFetch(fixture, userInfo);
    const prisma = {
      userIdentity: {
        findUnique: vi.fn().mockResolvedValue(linked ? {
          providerType: "zitadel", identityProviderId: null,
          user: { ...user, status: userStatus },
        } : null),
      },
      user: { create: vi.fn(), update: vi.fn() },
    };
    const svc = new OidcAuthService(createConfig({
      OIDC_ISSUER_URL: fixture.issuer,
      OIDC_CLIENT_ID: "rp-native-web",
      OIDC_CLI_CLIENT_ID: "rp-native-cli",
      OIDC_INVITATION_CLIENT_ID: "rp-native-invite",
      OIDC_AUDIENCE: "rp-native-web",
    }), prisma as unknown as PrismaService);
    return { svc, prisma, fetchMock };
  }

  it("accepts an existing MCP-only member's signed client+nonce ID proof without any Web grant", async () => {
    const fixture = await createTokenFixture(true, true, undefined, nonce,
      { audience: client }, subject);
    const { svc, prisma } = prepare(fixture);
    await expect(svc.authenticateMcpBootstrapTokens(fixture.token, client, nonce))
      .resolves.toMatchObject(user);
    expect(prisma.userIdentity.findUnique).toHaveBeenCalledWith({
      where: { issuer_externalSubject: {
        issuer: fixture.issuer, externalSubject: subject,
      } },
      include: { user: true },
    });
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("uses verified UserInfo for an identity-only token lacking signed email_verified, without creating an RP Web user", async () => {
    const fixture = await createTokenFixture(true, false, undefined, nonce,
      { audience: client }, subject, true);
    const f = prepare(fixture, true, UserStatus.Active, {
      sub: subject, email: "mcp-only@example.test", email_verified: true,
    });
    await expect(f.svc.authenticateMcpBootstrapTokens(
      fixture.token, client, nonce, "short-lived-userinfo-access",
    )).resolves.toMatchObject(user);
    expect(f.fetchMock).toHaveBeenCalledWith(
      fixture.issuer + "/oidc/v1/userinfo",
      expect.objectContaining({
        headers: { authorization: "Bearer short-lived-userinfo-access" },
      }),
    );
    expect(f.prisma.user.create).not.toHaveBeenCalled();
  });

  it("fails closed for unverified or mismatched UserInfo and without same-code-flow access token", async () => {
    const fixture = await createTokenFixture(true, false, undefined, nonce,
      { audience: client }, subject, true);
    let f = prepare(fixture, true, UserStatus.Active, {
      sub: "attacker-subject", email_verified: true,
    });
    await expect(f.svc.authenticateMcpBootstrapTokens(
      fixture.token, client, nonce, "short-lived-userinfo-access",
    )).rejects.toThrow("OIDC UserInfo subject mismatch");
    expect(f.prisma.userIdentity.findUnique).not.toHaveBeenCalled();
    vi.unstubAllGlobals();

    f = prepare(fixture, true, UserStatus.Active, {
      sub: subject, email_verified: false,
    });
    await expect(f.svc.authenticateMcpBootstrapTokens(
      fixture.token, client, nonce, "short-lived-userinfo-access",
    )).rejects.toThrow("MCP upstream email verification required");
    await expect(f.svc.authenticateMcpBootstrapTokens(
      fixture.token, client, nonce,
    )).rejects.toThrow("MCP upstream email verification required");
    expect(f.prisma.user.create).not.toHaveBeenCalled();
  });

  it("rejects a different tenant client, a replay with another nonce, and client-spoofed signed claims", async () => {
    const fixture = await createTokenFixture(true, true, undefined, nonce,
      { audience: client, azp: client }, subject);
    const { svc } = prepare(fixture);
    await expect(svc.authenticateMcpBootstrapTokens(fixture.token,
      "340396026519785999", nonce)).rejects.toThrow();
    await expect(svc.authenticateMcpBootstrapTokens(fixture.token,
      client, "X".repeat(43))).rejects.toThrow();
    const forged = await createTokenFixture(true, true, undefined, nonce,
      { audience: client, azp: "different-application" }, subject);
    vi.unstubAllGlobals();
    const other = prepare(forged);
    await expect(other.svc.authenticateMcpBootstrapTokens(
      forged.token, client, nonce,
    )).rejects.toThrow("Unbound MCP upstream identity proof");
  });

  it("rejects an unlinked or suspended identity, never provisioning from email", async () => {
    const fixture = await createTokenFixture(true, true, undefined, nonce,
      { audience: client }, subject);
    let f = prepare(fixture, false);
    await expect(f.svc.authenticateMcpBootstrapTokens(fixture.token,
      client, nonce)).rejects.toThrow("not an active linked account");
    expect(f.prisma.user.create).not.toHaveBeenCalled();
    f = prepare(fixture, true, UserStatus.Suspended);
    await expect(f.svc.authenticateMcpBootstrapTokens(fixture.token,
      client, nonce)).rejects.toThrow("not an active linked account");
  });
});
