import { ConfigService } from "@nestjs/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "../security/encryption.service";
import { AuthSessionService } from "./auth-session.service";
import { OidcAuthService } from "./oidc-auth.service";

function createConfig() {
  return {
    get: <T = string>(_key: string, defaultValue?: T) => defaultValue as T,
  } as ConfigService;
}

function createEncryption() {
  return {
    encrypt: vi.fn((value: string) => `enc:${value}`),
    decrypt: vi.fn((value: string) => value.replace(/^enc:/, "")),
  } as unknown as EncryptionService;
}

function createService(prisma: PrismaService) {
  return new AuthSessionService(
    createConfig(),
    prisma,
    {} as OidcAuthService,
    createEncryption(),
  );
}

describe("Stage 1 session policy defaults", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses a 7 day absolute session lifetime when no override is configured", async () => {
    const now = new Date("2026-08-30T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const create = vi.fn().mockImplementation(({ data }: { data: { expiresAt: Date } }) =>
      Promise.resolve({ id: "session-1", expiresAt: data.expiresAt }),
    );
    const prisma = {
      auditLogEntry: { create: vi.fn() },
      portalSession: { create },
    } as unknown as PrismaService;

    await createService(prisma).createSession("user-1", {
      access_token: "access-token",
      refresh_token: "refresh-token",
      id_token: "id-token",
      expires_in: 600,
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
        }) as unknown,
      }),
    );
  });

  it("uses a 12 hour idle timeout when no override is configured", async () => {
    const now = new Date("2026-08-30T12:00:00.000Z");
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const prisma = {
      auditLogEntry: { create: vi.fn() },
      portalSession: { updateMany },
    } as unknown as PrismaService;

    await createService(prisma).pruneExpiredSessions(now);

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { expiresAt: { lte: now } },
          { lastSeenAt: { lte: new Date("2026-08-30T00:00:00.000Z") } },
        ],
        revokedAt: null,
      },
      data: { revokedAt: now },
    });
  });
});
