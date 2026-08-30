import "reflect-metadata";
import fastifyCookie from "@fastify/cookie";
import { ConfigService } from "@nestjs/config";
import { APP_GUARD, Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import {
  FastifyAdapter,
  NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { UserStatus } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "../security/encryption.service";
import { AuthFlowService } from "./auth-flow.service";
import { AuthSessionService } from "./auth-session.service";
import { AuthController } from "./auth.controller";
import { DevAuthGuard } from "./dev-auth.guard";
import { OidcAuthService } from "./oidc-auth.service";

type ConfigValues = Record<string, string | undefined>;
type ResponseWithHeaders = {
  headers: Record<string, string | string[] | undefined>;
};
type PortalSessionCreateArgs = {
  data: {
    id: string;
    expiresAt: Date;
    accessToken?: string;
    idToken?: string;
    refreshToken?: string;
    userId?: string;
  };
  select?: Record<string, boolean>;
};

const cookieSecret = "ResourcePortalCookieSecretForTests";
const issuer = "https://issuer.example.com";
const user = {
  id: "user-1",
  email: "user@example.com",
  displayName: "Example User",
  status: UserStatus.Active,
};

function createConfig(values: ConfigValues) {
  return {
    get: <T = string>(key: string, defaultValue?: T) =>
      (values[key] ?? defaultValue) as T,
  } as ConfigService;
}

function getSetCookieHeaders(response: ResponseWithHeaders) {
  const setCookie = response.headers["set-cookie"];

  if (!setCookie) {
    return [];
  }

  return Array.isArray(setCookie) ? setCookie : [setCookie];
}

function getCookieHeader(response: ResponseWithHeaders) {
  return getSetCookieHeaders(response)
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

function getCookieValue(response: ResponseWithHeaders, name: string) {
  const cookie = getSetCookieHeaders(response).find((header) =>
    header.startsWith(`${name}=`),
  );

  return cookie?.split(";")[0]?.slice(name.length + 1);
}

function getRequiredHeader(response: ResponseWithHeaders, name: string) {
  const header = response.headers[name];

  if (Array.isArray(header)) {
    return header[0];
  }

  if (!header) {
    throw new Error(`Missing response header: ${name}`);
  }

  return header;
}

describe("AuthController cookie flow", () => {
  let app: NestFastifyApplication;
  let oidcAuth: {
    authenticateBearerToken: ReturnType<typeof vi.fn>;
    getDiscovery: ReturnType<typeof vi.fn>;
  };
  let prisma: {
    auditLogEntry: {
      create: ReturnType<typeof vi.fn>;
    };
    portalSession: {
      create: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    identityProvider: {
      findFirst: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
    };
    tenant: {
      findUnique: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(async () => {
    oidcAuth = {
      getDiscovery: vi.fn().mockResolvedValue({
        authorizationEndpoint: `${issuer}/oauth/v2/authorize`,
        issuer,
        jwksUri: `${issuer}/oauth/v2/keys`,
        tokenEndpoint: `${issuer}/oauth/v2/token`,
      }),
      authenticateBearerToken: vi.fn().mockResolvedValue(user),
    };
    prisma = {
      auditLogEntry: {
        create: vi.fn(),
      },
      portalSession: {
        create: vi.fn(({ data }: PortalSessionCreateArgs) =>
          Promise.resolve({
            id: data.id,
            expiresAt: data.expiresAt,
          }),
        ),
        findUnique: vi.fn().mockResolvedValue({
          id: "session-1",
          accessTokenExpiresAt: new Date(Date.now() + 3600_000),
          idToken: "id-token",
          refreshToken: "refresh-token",
          revokedAt: null,
          expiresAt: new Date(Date.now() + 3600_000),
          lastSeenAt: new Date(),
          user,
        }),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      identityProvider: {
        findFirst: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
      },
      tenant: {
        findUnique: vi.fn(),
      },
    };

    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;

        if (url !== `${issuer}/oauth/v2/token`) {
          return Promise.resolve(
            new Response("not found", {
              status: 404,
            }),
          );
        }

        const body = new URLSearchParams(init?.body as string);
        expect(body.get("grant_type")).toBe("authorization_code");
        expect(body.get("code")).toBe("valid-code");
        expect(body.get("client_id")).toBe("resource-portal");
        expect(body.get("code_verifier")).toBeTruthy();

        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: "access-token",
              expires_in: 3600,
              id_token: "id-token",
              refresh_token: "refresh-token",
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          ),
        );
      }),
    );

    Reflect.defineMetadata(
      "design:paramtypes",
      [AuthFlowService, AuthSessionService],
      AuthController,
    );
    Reflect.defineMetadata(
      "design:paramtypes",
      [ConfigService, OidcAuthService, AuthSessionService, PrismaService],
      AuthFlowService,
    );
    Reflect.defineMetadata(
      "design:paramtypes",
      [ConfigService, PrismaService, OidcAuthService, EncryptionService],
      AuthSessionService,
    );
    Reflect.defineMetadata(
      "design:paramtypes",
      [
        Reflector,
        ConfigService,
        PrismaService,
        OidcAuthService,
        AuthSessionService,
      ],
      DevAuthGuard,
    );

    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        AuthFlowService,
        AuthSessionService,
        Reflector,
        {
          provide: EncryptionService,
          useValue: {
            encrypt: (value: string) => value,
            decrypt: (value: string) => value,
          },
        },
        {
          provide: ConfigService,
          useValue: createConfig({
            AUTH_COOKIE_SECRET: cookieSecret,
            AUTH_CSRF_COOKIE_NAME: "rp_csrf",
            AUTH_MODE: "oidc",
            AUTH_SESSION_COOKIE_NAME: "rp_session",
            AUTH_SESSION_TTL_SECONDS: "3600",
            AUTH_SESSION_IDLE_TIMEOUT_SECONDS: "1800",
            OIDC_CLIENT_ID: "resource-portal",
            OIDC_CLIENT_SECRET: "client-secret",
            OIDC_ISSUER_URL: issuer,
            OIDC_REDIRECT_URI: "http://localhost/api/auth/callback",
            PUBLIC_API_URL: "http://localhost",
            ZITADEL_ORGANIZATION_ID: "zitadel-org-1",
          }),
        },
        {
          provide: PrismaService,
          useValue: prisma,
        },
        {
          provide: OidcAuthService,
          useValue: oidcAuth,
        },
        {
          provide: DevAuthGuard,
          inject: [
            Reflector,
            ConfigService,
            PrismaService,
            OidcAuthService,
            AuthSessionService,
          ],
          useFactory: (
            reflector: Reflector,
            config: ConfigService,
            prismaService: PrismaService,
            oidcAuthService: OidcAuthService,
            sessions: AuthSessionService,
          ) =>
            new DevAuthGuard(
              reflector,
              config,
              prismaService,
              oidcAuthService,
              sessions,
            ),
        },
        {
          provide: APP_GUARD,
          useExisting: DevAuthGuard,
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.register(fastifyCookie, {
      secret: cookieSecret,
    });
    app.setGlobalPrefix("api");
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
    vi.unstubAllGlobals();
  });

  it("starts OIDC login with signed callback cookies", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/auth/login",
    });

    expect(response.statusCode).toBe(302);
    expect(getRequiredHeader(response, "location")).toContain(
      `${issuer}/oauth/v2/authorize`,
    );

    const location = new URL(getRequiredHeader(response, "location"));
    const state = location.searchParams.get("state");
    const stateCookie = getCookieValue(response, "rp_oidc_state");
    const verifierCookie = getCookieValue(response, "rp_oidc_verifier");

    expect(location.searchParams.get("client_id")).toBe("resource-portal");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(state).toBeTruthy();
    expect(stateCookie).toBeTruthy();
    expect(verifierCookie).toBeTruthy();
    expect(
      app.getHttpAdapter().getInstance().unsignCookie(stateCookie).value,
    ).toBe(state);
    expect(
      app.getHttpAdapter().getInstance().unsignCookie(verifierCookie).valid,
    ).toBe(true);
  });

  it("rejects callback without code or state", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/auth/callback",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      message: "OIDC callback code and state are required",
    });
  });

  it("selects an enabled tenant identity provider through ZITADEL scopes", async () => {
    const tenantId = "11111111-1111-4111-8111-111111111111";
    const identityProviderId = "22222222-2222-4222-8222-222222222222";
    prisma.tenant.findUnique.mockResolvedValue({
      authPolicy: {
        allowPlatformLogin: true,
        allowTenantIdentityProviders: true,
        requireTenantIdentityProvider: false,
      },
    });
    prisma.identityProvider.findFirst.mockResolvedValue({
      id: identityProviderId,
      scope: "Tenant",
      tenantId,
      zitadelIdentityProviderId: "zitadel-idp-1",
    });

    const loginResponse = await app.inject({
      method: "GET",
      url: `/api/auth/login?tenantId=${tenantId}&identityProviderId=${identityProviderId}`,
    });
    const loginLocation = new URL(getRequiredHeader(loginResponse, "location"));
    const scopes = loginLocation.searchParams.get("scope")?.split(" ") ?? [];

    expect(loginResponse.statusCode).toBe(302);
    expect(scopes).toContain("urn:zitadel:iam:org:id:zitadel-org-1");
    expect(scopes).toContain("urn:zitadel:iam:org:idp:id:zitadel-idp-1");
    expect(getCookieValue(loginResponse, "rp_oidc_provider")).toBeTruthy();

    const callbackResponse = await app.inject({
      method: "GET",
      url: `/api/auth/callback?code=valid-code&state=${loginLocation.searchParams.get("state")}`,
      headers: { cookie: getCookieHeader(loginResponse) },
    });

    expect(callbackResponse.statusCode).toBe(302);
    expect(oidcAuth.authenticateBearerToken).toHaveBeenCalledWith(
      "id-token",
      identityProviderId,
    );
  });

  it("rejects callback with tampered signed cookies", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/auth/callback?code=valid-code&state=abc",
      headers: {
        cookie: "rp_oidc_state=abc.bad; rp_oidc_verifier=verifier.bad",
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      message: "OIDC state is invalid",
    });
  });

  it("creates session and CSRF cookies and authenticates requests", async () => {
    const loginResponse = await app.inject({
      method: "GET",
      url: "/api/auth/login",
    });
    const loginLocation = new URL(getRequiredHeader(loginResponse, "location"));
    const callbackResponse = await app.inject({
      method: "GET",
      url: `/api/auth/callback?code=valid-code&state=${loginLocation.searchParams.get(
        "state",
      )}`,
      headers: {
        cookie: getCookieHeader(loginResponse),
      },
    });

    expect(callbackResponse.statusCode).toBe(302);
    expect(callbackResponse.headers.location).toBe("/");

    const createArgs = prisma.portalSession.create.mock
      .calls[0]?.[0] as PortalSessionCreateArgs;
    expect(createArgs.data).toMatchObject({
      accessToken: "access-token",
      idToken: "id-token",
      refreshToken: "refresh-token",
      userId: user.id,
    });
    expect(createArgs.select).toEqual({
      expiresAt: true,
      id: true,
    });

    const sessionCookie = getCookieValue(callbackResponse, "rp_session");
    const csrfCookie = getCookieValue(callbackResponse, "rp_csrf");
    expect(csrfCookie).toBeTruthy();
    expect(
      getSetCookieHeaders(callbackResponse).find((cookie) =>
        cookie.startsWith("rp_csrf="),
      ),
    ).not.toContain("HttpOnly");

    const unsignedSession = app
      .getHttpAdapter()
      .getInstance()
      .unsignCookie(sessionCookie);
    expect(unsignedSession.valid).toBe(true);

    const meResponse = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: {
        cookie: `rp_session=${sessionCookie}`,
      },
    });

    expect(meResponse.statusCode).toBe(200);
    expect(meResponse.json()).toEqual(user);
    expect(prisma.portalSession.findUnique).toHaveBeenCalledWith({
      where: {
        id: unsignedSession.value,
      },
      include: {
        user: true,
      },
    });
  });

  it("revokes the signed session cookie on logout and clears CSRF", async () => {
    const signedSession = app
      .getHttpAdapter()
      .getInstance()
      .signCookie("session-1");
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: {
        cookie: `rp_session=${signedSession}`,
      },
    });

    expect(response.statusCode).toBe(204);
    expect(prisma.portalSession.updateMany).toHaveBeenCalledWith({
      where: {
        id: "session-1",
        revokedAt: null,
      },
      data: {
        revokedAt: expect.any(Date) as Date,
      },
    });
    expect(
      getSetCookieHeaders(response).some((cookie) =>
        cookie.includes("rp_session=;"),
      ),
    ).toBe(true);
    expect(
      getSetCookieHeaders(response).some((cookie) =>
        cookie.includes("rp_csrf=;"),
      ),
    ).toBe(true);
  });
});
