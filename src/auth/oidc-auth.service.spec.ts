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

async function createTokenFixture() {
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

describe("OidcAuthService", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("verifies an OIDC token and auto-provisions a user identity", async () => {
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
    const fetchMock = vi.fn((input: string | URL | Request) => {
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
    });

    vi.stubGlobal("fetch", fetchMock);

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
});
