import { ConfigService } from "@nestjs/config";
import { UserStatus } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
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

describe("AuthSessionService", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
          user: {
            id: "user-1",
            email: "user@example.com",
            displayName: "Example User",
            status: UserStatus.Active,
          },
        }),
        update: vi.fn(),
      },
    };
    const service = new AuthSessionService(
      createConfig(),
      prisma as unknown as PrismaService,
      createOidcAuth(),
    );

    await expect(service.authenticateSession("session-1")).rejects.toThrow(
      "Session is invalid",
    );
    expect(prisma.portalSession.update).not.toHaveBeenCalled();
  });

  it("marks expired active sessions as revoked", async () => {
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
      createConfig(),
      prisma as unknown as PrismaService,
      createOidcAuth(),
    );

    await expect(service.pruneExpiredSessions(now)).resolves.toEqual({
      revokedSessions: 3,
    });
    expect(prisma.portalSession.updateMany).toHaveBeenCalledWith({
      where: {
        expiresAt: {
          lte: now,
        },
        revokedAt: null,
      },
      data: {
        revokedAt: now,
      },
    });
    expect(prisma.auditLogEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "auth.sessions.pruned",
        actor: "system",
        changes: {
          revokedSessions: 3,
        },
        resourceType: "PortalSession",
        result: "Success",
        tenantId: null,
        tenantName: "global",
      }) as unknown,
    });
  });

  it("refreshes expired access tokens for otherwise valid sessions", async () => {
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
          idToken: "old-id-token",
          refreshToken: "old-refresh-token",
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
        accessToken: "new-access-token",
        accessTokenExpiresAt: expect.any(Date) as Date,
        idToken: "new-id-token",
        refreshToken: "new-refresh-token",
      },
    });
    expect(prisma.portalSession.update).toHaveBeenNthCalledWith(2, {
      where: {
        id: "session-1",
      },
      data: {
        lastSeenAt: expect.any(Date) as Date,
      },
    });
    expect(prisma.portalSession.updateMany).not.toHaveBeenCalled();
    expect(prisma.auditLogEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "auth.session.refreshed",
        actor: "user-1",
        changes: {
          accessTokenExpiresInSeconds: 600,
          sessionId: "session-1",
        },
        resourceName: "session-1",
        resourceType: "PortalSession",
        result: "Success",
      }) as unknown,
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
          idToken: "old-id-token",
          refreshToken: "old-refresh-token",
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
    expect(prisma.auditLogEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "auth.session.refresh_failed",
        actor: "user-1",
        errorCode: "OIDC_REFRESH_FAILED",
        resourceName: "session-1",
        resourceType: "PortalSession",
        result: "Failure",
      }) as unknown,
    });
  });
});
