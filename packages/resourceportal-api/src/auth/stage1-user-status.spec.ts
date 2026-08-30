import { ConfigService } from "@nestjs/config";
import { UserStatus } from "@prisma/client";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import { OidcAuthService } from "./oidc-auth.service";

function createConfig(values: Record<string, string>) {
  return {
    get: <T = string>(key: string, defaultValue?: T) =>
      (values[key] ?? defaultValue) as T,
  } as ConfigService;
}

async function verifiedTokenFixture() {
  const issuer = "https://issuer.example.com";
  const audience = "resource-portal";
  const subject = "zitadel-user-1";
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = "stage1-key";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";

  const token = await new SignJWT({
    email: "user@example.com",
    email_verified: true,
    name: "Example User",
  })
    .setProtectedHeader({ alg: "RS256", kid: "stage1-key" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(subject)
    .setExpirationTime("5m")
    .sign(privateKey);

  return { issuer, audience, subject, publicJwk, token };
}

describe("Stage 1 global user status enforcement", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not reactivate a suspended user when OIDC email is verified", async () => {
    const fixture = await verifiedTokenFixture();
    const existingUser = {
      id: "31af4f62-2897-4181-965d-176728ad2e36",
      email: "user@example.com",
      displayName: "Example User",
      status: UserStatus.Suspended,
    };

    const update = vi.fn().mockImplementation(({ data }: { data: { status?: UserStatus } }) =>
      Promise.resolve({
        ...existingUser,
        status: data.status ?? existingUser.status,
      }),
    );
    const prisma = {
      userIdentity: {
        findUnique: vi.fn().mockResolvedValue({
          id: "identity-1",
          userId: existingUser.id,
          user: existingUser,
        }),
      },
      user: {
        findUnique: vi.fn().mockResolvedValue(null),
        update,
      },
    } as unknown as PrismaService;

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
                jwks_uri: `${fixture.issuer}/oauth/v2/keys`,
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }
        if (url === `${fixture.issuer}/oauth/v2/keys`) {
          return Promise.resolve(
            new Response(JSON.stringify({ keys: [fixture.publicJwk] }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }
        return Promise.resolve(new Response("not found", { status: 404 }));
      }),
    );

    const service = new OidcAuthService(
      createConfig({
        OIDC_ISSUER_URL: fixture.issuer,
        OIDC_CLIENT_ID: fixture.audience,
        OIDC_PROVIDER_TYPE: "zitadel",
      }),
      prisma,
    );

    await expect(service.authenticateBearerToken(fixture.token)).resolves.toMatchObject({
      status: UserStatus.Suspended,
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ status: UserStatus.Active }) as unknown,
      }),
    );
  });
});
