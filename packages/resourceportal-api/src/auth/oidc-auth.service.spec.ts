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

async function createTokenFixture(emailVerified = true, includeEmail = true, authenticatedIdpId?: string) {
  const issuer = "https://issuer.example.com";
  const audience = "resource-portal";
  const subject = "zitadel-user-1";
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  const keyId = "test-key";
  publicJwk.kid = keyId;
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";

  const token = await new SignJWT({
    ...(includeEmail ? { email: "User@Example.com" } : {}),
    email_verified: emailVerified,
    name: "Example User",
    ...(authenticatedIdpId ? { "urn:resourceportal:auth:external_idp_id": authenticatedIdpId } : {}),
  })
    .setProtectedHeader({
      alg: "RS256",
      kid: keyId,
    })
    .setIssuer(issuer)
    .setAudience(audience)
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
