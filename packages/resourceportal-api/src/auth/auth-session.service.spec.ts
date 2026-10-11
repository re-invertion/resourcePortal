import { UnauthorizedException } from "@nestjs/common";
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
      revocationEndpoint: `${issuer}/oauth/v2/revoke`,
      endSessionEndpoint: `${issuer}/oidc/v1/end_session`,
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
      auditLogEntry: { create: vi.fn() },
      portalSession: {
        create: vi.fn().mockResolvedValue({
          id: "session-1",
          expiresAt: new Date(Date.now() + 3600_000),
        }),
      },
    };
    const service = new AuthSessionService(
      createConfig(),
      prisma as unknown as PrismaService,
      createOidcAuth(),
      createEncryption(),
    );

    await service.createSession("user-1", {
      access_token: "access-token",
      refresh_token: "refresh-token",
      id_token: "id-token",
      expires_in: 600,
    });

    expect(prisma.portalSession.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        accessToken: "enc:access-token",
        refreshToken: "enc:refresh-token",
        idToken: "enc:id-token",
      }) as unknown,
      select: { id: true, expiresAt: true },
    });
  });

  it("rejects expired sessions", async () => {
    const prisma = {
      auditLogEntry: { create: vi.fn() },
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
    expect(prisma.portalSession.updateMany).toHaveBeenCalled();
  });

  it("rejects sessions that exceed the idle timeout", async () => {
    const now = Date.now();
    const prisma = {
      auditLogEntry: { create: vi.fn() },
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

  it("does not duplicate the revoke audit when a session is already revoked", async () => {
    const prisma = {
      auditLogEntry: { create: vi.fn() },
      portalSession: {
        findUnique: vi.fn().mockResolvedValue({
          id: "session-1",
          user: { id: "user-1", displayName: "Example User" },
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const service = new AuthSessionService(
      createConfig(),
      prisma as unknown as PrismaService,
      createOidcAuth(),
      createEncryption(),
    );

    await service.revokeSession("session-1");

    expect(prisma.portalSession.updateMany).toHaveBeenCalled();
    expect(prisma.auditLogEntry.create).not.toHaveBeenCalled();
  });

  it("marks expired or idle sessions as revoked", async () => {
    const now = new Date("2026-08-29T10:00:00.000Z");
    const prisma = {
      auditLogEntry: { create: vi.fn() },
      portalSession: { updateMany: vi.fn().mockResolvedValue({ count: 3 }) },
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
          { expiresAt: { lte: now } },
          { lastSeenAt: { lte: new Date("2026-08-29T09:30:00.000Z") } },
        ],
        revokedAt: null,
      },
      data: { revokedAt: now },
    });
  });

  it("decrypts refresh tokens and stores refreshed tokens encrypted", async () => {
    const prisma = {
      auditLogEntry: { create: vi.fn() },
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
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn(),
      },
    };

    (prisma as typeof prisma & { $transaction: unknown }).$transaction = async (
      action: (tx: unknown) => Promise<unknown>,
    ) => action({
      $queryRaw: vi.fn().mockResolvedValue([]),
      portalSession: {
        findUnique: prisma.portalSession.findUnique,
        update: prisma.portalSession.update,
      },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn((_input: string | URL | Request, init?: RequestInit) => {
        const body = new URLSearchParams(init?.body as string);
        expect(body.get("refresh_token")).toBe("old-refresh-token");
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: "new-access-token",
              expires_in: 600,
              id_token: "new-id-token",
              refresh_token: "new-refresh-token",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
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
      createOidcAuth(),
      createEncryption(),
    );

    await service.authenticateSession("session-1");
    expect(prisma.portalSession.update).toHaveBeenNthCalledWith(1, {
      where: { id: "session-1" },
      data: {
        accessToken: "enc:new-access-token",
        accessTokenExpiresAt: expect.any(Date) as Date,
        idToken: "enc:new-id-token",
        refreshToken: "enc:new-refresh-token",
      },
    });
  });

  it("lists only active session metadata and marks the current session", async () => {
    const now = new Date();
    const prisma = {
      portalSession: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "session-2",
            createdAt: now,
            lastSeenAt: now,
            expiresAt: new Date(now.getTime() + 3600_000),
            accessTokenExpiresAt: new Date(now.getTime() + 600_000),
          },
          {
            id: "session-1",
            createdAt: now,
            lastSeenAt: now,
            expiresAt: new Date(now.getTime() + 3600_000),
            accessTokenExpiresAt: new Date(now.getTime() + 600_000),
          },
        ]),
      },
    };
    const service = new AuthSessionService(
      createConfig({ AUTH_SESSION_IDLE_TIMEOUT_SECONDS: "1800" }),
      prisma as unknown as PrismaService,
      createOidcAuth(),
      createEncryption(),
    );

    const result = await service.listActiveSessions("user-1", "session-1");
    expect(result).toEqual([
      expect.objectContaining({ id: "session-2", isCurrent: false }),
      expect.objectContaining({ id: "session-1", isCurrent: true }),
    ]);
    for (const session of result) {
      expect(session).not.toHaveProperty("accessToken");
      expect(session).not.toHaveProperty("refreshToken");
      expect(session).not.toHaveProperty("idToken");
    }
    const findManyArgs = prisma.portalSession.findMany.mock.lastCall?.[0] as unknown;
    expect(findManyArgs).toMatchObject({
      where: { userId: "user-1", revokedAt: null },
      select: {
        id: true,
        createdAt: true,
        lastSeenAt: true,
        expiresAt: true,
        accessTokenExpiresAt: true,
      },
    });
  });

  it("revokes the provider refresh token and builds the end-session URL", async () => {
    const prisma = {
      auditLogEntry: { create: vi.fn() },
      portalSession: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce({
            id: "session-1",
            accessToken: "enc:access-token",
            refreshToken: "enc:refresh-token",
            idToken: "enc:id-token",
            user: {
              id: "user-1",
              displayName: "Example User",
            },
          })
          .mockResolvedValueOnce({
            id: "session-1",
            user: {
              id: "user-1",
              displayName: "Example User",
            },
          }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };

    vi.stubGlobal(
      "fetch",
      vi.fn((_input: string | URL | Request, init?: RequestInit) => {
        const body = new URLSearchParams(init?.body as string);
        expect(body.get("token")).toBe("refresh-token");
        expect(body.get("client_id")).toBe("resource-portal");
        return Promise.resolve(new Response(null, { status: 200 }));
      }),
    );

    const service = new AuthSessionService(
      createConfig({
        OIDC_CLIENT_ID: "resource-portal",
        OIDC_CLIENT_SECRET: "client-secret",
        OIDC_POST_LOGOUT_REDIRECT_URI: "https://portal.example.com/logged-out",
      }),
      prisma as unknown as PrismaService,
      createOidcAuth(),
      createEncryption(),
    );

    const result = await service.prepareProviderLogout("session-1");
    expect(result.providerTokenRevoked).toBe(true);
    expect(result.logoutUrl).toContain(`${issuer}/oidc/v1/end_session`);
    expect(result.logoutUrl).toContain("id_token_hint=id-token");
    expect(result.logoutUrl).toContain("client_id=resource-portal");
    expect(result.logoutUrl).toContain(
      "post_logout_redirect_uri=https%3A%2F%2Fportal.example.com%2Flogged-out",
    );
    expect(prisma.portalSession.updateMany).toHaveBeenCalledWith({
      where: { id: "session-1", revokedAt: null },
      data: { revokedAt: expect.any(Date) as Date },
    });
  });
});

describe("session refresh rotation is serialized across worker instances (#222)", () => {
  it("performs one refresh and keeps both requests authenticated", async () => {
    const user = { id: "user-1", email: "a@example.com",
      displayName: "User", status: UserStatus.Active };
    const session = {
      id: "session-1", revokedAt: null, user,
      accessTokenExpiresAt: new Date(Date.now() - 10_000),
      expiresAt: new Date(Date.now() + 3600_000),
      lastSeenAt: new Date(),
      accessToken: "enc:old-access-token",
      refreshToken: "enc:old-refresh-token",
      idToken: "enc:old-id-token",
    };
    const findUnique = vi.fn(() => Promise.resolve({ ...session }));
    const update = vi.fn(({ data }: { data: Record<string, unknown> }) => {
      Object.assign(session, data);
      return Promise.resolve({ ...session });
    });
    let previous = Promise.resolve();
    const queryRaw = vi.fn().mockResolvedValue([]);
    const $transaction = vi.fn(async (
      action: (tx: { $queryRaw: typeof queryRaw; portalSession: {
        findUnique: typeof findUnique; update: typeof update;
      } }) => Promise<unknown>,
    ) => {
      const before = previous;
      let unlock!: () => void;
      previous = new Promise<void>((resolve) => { unlock = resolve; });
      await before;
      try {
        return await action({ $queryRaw: queryRaw, portalSession: { findUnique, update } });
      } finally {
        unlock();
      }
    });
    const prisma = {
      $transaction, auditLogEntry: { create: vi.fn().mockResolvedValue({}) },
      portalSession: { findUnique, update, updateMany: vi.fn() },
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: "rotated-token", refresh_token: "new-refresh-token",
      id_token: "new-id-token", expires_in: 600,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const mkService = () => new AuthSessionService(
      createConfig({ OIDC_CLIENT_ID: "resource-portal" }),
      prisma as unknown as PrismaService, createOidcAuth(), createEncryption(),
    );
    const first = mkService();
    const second = mkService();
    const [a, b] = await Promise.all([
      first.authenticateSession(session.id),
      second.authenticateSession(session.id),
    ]);
    expect(a.id).toBe(user.id);
    expect(b.id).toBe(user.id);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(session.refreshToken).toBe("enc:new-refresh-token");
    expect(prisma.portalSession.updateMany).not.toHaveBeenCalled();
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });
});

describe("OIDC provider outage retains browser session", () => {
  it("does not revoke a valid session when OIDC discovery temporarily fails with an authentication exception (#215)", async () => {
    const session = {
      id: "session-oidc-down", revokedAt: null, idToken: "enc:id-token",
      refreshToken: "enc:refresh-token", accessToken: "enc:access-token",
      expiresAt: new Date(Date.now() + 3600_000),
      lastSeenAt: new Date(),
      accessTokenExpiresAt: new Date(Date.now() - 1000),
      user: { id: "user-1", email: "u@example.com", displayName: "User", status: UserStatus.Active },
    };
    const findUnique = vi.fn().mockResolvedValue(session);
    const updateMany = vi.fn();
    const prisma = {
      auditLogEntry: { create: vi.fn().mockResolvedValue({}) },
      portalSession: { findUnique, updateMany },
      $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) =>
        work({ $queryRaw: vi.fn().mockResolvedValue([]), portalSession: { findUnique } })),
    };
    const oidcAuth = {
      getDiscovery: vi.fn().mockRejectedValue(
        new UnauthorizedException("OIDC discovery document is unavailable"),
      ),
    } as unknown as OidcAuthService;
    const service = new AuthSessionService(
      createConfig({ OIDC_CLIENT_ID: "resource-portal" }),
      prisma as unknown as PrismaService, oidcAuth, createEncryption(),
    );
    await expect(service.authenticateSession(session.id)).rejects.toThrow(
      "OIDC refresh temporarily unavailable",
    );
    expect(updateMany).not.toHaveBeenCalled();
  });
});
