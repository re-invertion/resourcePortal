import { ConfigService } from "@nestjs/config";
import { UserStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import { AuthSessionService } from "./auth-session.service";

function createConfig() {
  return {
    get: <T = string>(_key: string, defaultValue?: T) => defaultValue as T,
  } as ConfigService;
}

describe("AuthSessionService", () => {
  it("rejects expired sessions", async () => {
    const prisma = {
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
    );

    await expect(service.authenticateSession("session-1")).rejects.toThrow(
      "Session is invalid",
    );
    expect(prisma.portalSession.update).not.toHaveBeenCalled();
  });

  it("marks expired active sessions as revoked", async () => {
    const now = new Date("2026-08-29T10:00:00.000Z");
    const prisma = {
      portalSession: {
        updateMany: vi.fn().mockResolvedValue({
          count: 3,
        }),
      },
    };
    const service = new AuthSessionService(
      createConfig(),
      prisma as unknown as PrismaService,
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
  });
});
