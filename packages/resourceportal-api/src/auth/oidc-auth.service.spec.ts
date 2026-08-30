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

async function createTokenFixture(emailVerified = true) {
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
    email: "User@Example.com",
    email_verified: emailVerified,
    name: "Example User",
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

function installOidcFetch(fixture: Awaited<ReturnType<typeof createTokenFixture>>) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL | Request) => {
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
              revocation_endpoint: `${fixture.issuer}/oauth/v2/revoke`,
              end_session_endpoint: `${fixture.issuer}/oidc/v1/end_session`,
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
    }),
  );
}

describe("OidcAuthService", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
