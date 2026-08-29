import { ConfigService } from "@nestjs/config";
import { UserStatus } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "../security/encryption.service";
import { AuthSessionService } from "./auth-session.service";
import { OidcAuthService } from "./oidc-auth.service";

const issuer = "https://issuer.example.com";

function createConfig(values: Record<string, string | undefined> = {}) {
  return {
    get: <T = string>(key: string, defaultValue?: T) =>
      (values[key] ?? defaultValue) as T,
  } as ConfigService;
}

function createOidcAuth() {
  return {
    getDiscovery: vi.fn().mockResolvedValue({
      authorizationEndpoint: `${issuer}/oauth/v2/authorize`,
      issuer,
      jwksUri: `${issuer}/oauth/v2/keys`,
      tokenEndpoint: `${issuer}/oauth/v2/token`,
    }),
  } as unknown as OidcAuthService;
}

function createEncryption() {
  return {
    encrypt: vi.fn((value: string) => `enc:${value}`),
    decrypt: vi.fn((value: string) =>
      value.startsWith("enc:") ? value.slice(4) : value,
    ),
  } as unknown as EncryptionService;
}

describe("AuthSessionService", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("encrypts OIDC tokens when creating a session", async () => {
    const prisma = {
      auditLogEntry: {
        create: vi.fn(),
      },
      portalSession: {
        create: vi.fn().mockResolvedValue({
          id: "session-1",
          expiresAt: new Date(Date.now() + 3600_000),
        }),
      },
    };
    const encryption = createEncryption();
    const service = new AuthSessionService(
      createConfig(),
      prisma as unknown as PrismaService,
      createOidcAuth(),
      encryption,
    );

    await service.createSession("user-1", {
      access_token: "access-token",
      refresh_token: "refresh-token",
      id_token: "id-token",
      expires_in: 600,
      token_type: "Bearer",
    });

    expect(prisma.portalSession.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        accessToken: "enc:access-token",
        refreshToken: "enc:refresh-token",
        idToken: "enc:id-token",
      }) as unknown,
      select: {
        id: true,
        expiresAt: true,
      },
    });
  });

  it("rejects expired sessions", async () => {
    const prisma = {
      auditLogEntry: {
        create: vi.fn(),
      },
      portalSession: {
        findUnique: vi.fn().mockResolvedValue({
          id: "session-1",
          revokedAt: null,
          expiresAt: new Date(Date.now() - 1000),
          lastSeenAt: new Date(),
          user: {
            id: "user-1",
            email: "user@example.com",
            displayName: "Example User",
            status: UserStatus.Active,
          },
        }),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const service = new AuthSessionService(
      createConfig(),
      prisma as unknown as PrismaService,
      createOidcAuth(),
      createEncryption(),
    );

    await expect(service.authenticateSession("session-1")).rejects.toThrow(
      "Session is invalid",
    );
    expect(prisma.portalSession.update).not.toHaveBeenCalled();
    expect(prisma.portalSession.updateMany).toHaveBeenCalled();
  });

  it("rejects sessions that exceed the idle timeout", async () => {
    const now = Date.now();
    const prisma = {
      auditLogEntry: {
        create: vi.fn(),
      },
      portalSession: {
        findUnique: vi.fn().mockResolvedValue({
          id: "session-1",
          revokedAt: null,
          expiresAt: new Date(now + 3600_000),
          lastSeenAt: new Date(now - 601_000),
          accessTokenExpiresAt: new Date(now + 60_000),
          user: {
            id: "user-1",
            email: "user@example.com",
            displayName: "Example User",
            status: UserStatus.Active,
          },
        }),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const service = new AuthSessionService(
      createConfig({ AUTH_SESSION_IDLE_TIMEOUT_SECONDS: "600" }),
      prisma as unknown as PrismaService,
      createOidcAuth(),
      createEncryption(),
    );

    await expect(service.authenticateSession("session-1")).rejects.toThrow(
      "Session is invalid",
    );
    expect(prisma.portalSession.updateMany).toHaveBeenCalled();
  });

  it("marks expired or idle sessions as revoked", async () => {
    const now = new Date("2026-08-29T10:00:00.000Z");
    const prisma = {
      auditLogEntry: {
        create: vi.fn(),
      },
      portalSession: {
        updateMany: vi.fn().mockResolvedValue({
          count: 3,
        }),
      },
    };
    const service = new AuthSessionService(
      createConfig({ AUTH_SESSION_IDLE_TIMEOUT_SECONDS: "1800" }),
      prisma as unknown as PrismaService,
      createOidcAuth(),
      createEncryption(),
    );

    await expect(service.pruneExpiredSessions(now)).resolves.toEqual({
      revokedSessions: 3,
    });
    expect(prisma.portalSession.updateMany).toHaveBeenCalledWith({
      where: {
        OR: [
          {
            expiresAt: {
              lte: now,
            },
          },
          {
            lastSeenAt: {
              lte: new Date("2026-08-29T09:30:00.000Z"),
            },
          },
        ],
        revokedAt: null,
      },
      data: {
        revokedAt: now,
      },
    });
  });

  it("decrypts refresh tokens and stores refreshed tokens encrypted", async () => {
    const sessionExpiresAt = new Date(Date.now() + 3600_000);
    const prisma = {
      auditLogEntry: {
        create: vi.fn(),
      },
      portalSession: {
        findUnique: vi.fn().mockResolvedValue({
          id: "session-1",
          accessTokenExpiresAt: new Date(Date.now() - 1000),
          expiresAt: sessionExpiresAt,
          lastSeenAt: new Date(),
          idToken: "enc:old-id-token",
          refreshToken: "enc:old-refresh-token",
          revokedAt: null,
          user: {
            id: "user-1",
            email: "user@example.com",
            displayName: "Example User",
            status: UserStatus.Active,
          },
        }),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn(),
      },
    };
    const oidcAuth = createOidcAuth();

    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;

        expect(url).toBe(`${issuer}/oauth/v2/token`);
        const body = new URLSearchParams(init?.body as string);
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("refresh_token")).toBe("old-refresh-token");
        expect(body.get("client_id")).toBe("resource-portal");

        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: "new-access-token",
              expires_in: 600,
              id_token: "new-id-token",
              refresh_token: "new-refresh-token",
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

    const service = new AuthSessionService(
      createConfig({
        OIDC_CLIENT_ID: "resource-portal",
        OIDC_CLIENT_SECRET: "client-secret",
      }),
      prisma as unknown as PrismaService,
      oidcAuth,
      createEncryption(),
    );

    await expect(service.authenticateSession("session-1")).resolves.toEqual({
      id: "user-1",
      email: "user@example.com",
      displayName: "Example User",
      status: UserStatus.Active,
    });
    expect(prisma.portalSession.update).toHaveBeenNthCalledWith(1, {
      where: {
        id: "session-1",
      },
      data: {
        accessToken: "enc:new-access-token",
        accessTokenExpiresAt: expect.any(Date) as Date,
        idToken: "enc:new-id-token",
        refreshToken: "enc:new-refresh-token",
      },
    });
  });

  it("revokes the session when token refresh fails", async () => {
    const prisma = {
      auditLogEntry: {
        create: vi.fn(),
      },
      portalSession: {
        findUnique: vi.fn().mockResolvedValue({
          id: "session-1",
          accessTokenExpiresAt: new Date(Date.now() - 1000),
          expiresAt: new Date(Date.now() + 3600_000),
          lastSeenAt: new Date(),
          idToken: "enc:old-id-token",
          refreshToken: "enc:old-refresh-token",
          revokedAt: null,
          user: {
            id: "user-1",
            email: "user@example.com",
            displayName: "Example User",
            status: UserStatus.Active,
          },
        }),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: "invalid_grant" }), {
            status: 400,
            headers: {
              "content-type": "application/json",
            },
          }),
        ),
      ),
    );

    const service = new AuthSessionService(
      createConfig({
        OIDC_CLIENT_ID: "resource-portal",
      }),
      prisma as unknown as PrismaService,
      createOidcAuth(),
      createEncryption(),
    );

    await expect(service.authenticateSession("session-1")).rejects.toThrow(
      "OIDC refresh token exchange failed",
    );
    expect(prisma.portalSession.update).not.toHaveBeenCalled();
    expect(prisma.portalSession.updateMany).toHaveBeenCalledWith({
      where: {
        id: "session-1",
        revokedAt: null,
      },
      data: {
        revokedAt: expect.any(Date) as Date,
      },
    });
  });
});
