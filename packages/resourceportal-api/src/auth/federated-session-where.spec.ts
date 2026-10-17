import { describe, expect, it, vi } from "vitest";
import type { ConfigService } from "@nestjs/config";
import type { PrismaService } from "../prisma/prisma.service";
import { activeFederatedSessionWhere } from "./federated-session-where";
import { NativeLoginModeService } from "./native-login-mode.service";
import { TenantOidcAutoRolloutService } from "../tenant-oidc/tenant-oidc-auto-rollout.service";
import type { TenantOidcService } from "../tenant-oidc/tenant-oidc.service";

const now = new Date("2026-10-13T21:00:00Z");
const cfg = { get: (key: string, defaultValue?: string) => ({
  RP_NATIVE_LOGIN_ONLY: "auto", TENANT_OIDC_AUTO_ROLLOUT: "true",
  TENANT_OIDC_ACTIVATION_ALLOWED: "auto", OIDC_ISSUER_URL: "https://auth.rp.test",
  ZITADEL_MANAGEMENT_TOKEN: "test", ZITADEL_ORGANIZATION_ID: "org",
  AUTH_SESSION_IDLE_TIMEOUT_SECONDS: "600",
} as Record<string, string>)[key] ?? defaultValue } as ConfigService;

describe("native-only and tenant rollout exclude historical federation sessions", () => {
  it("uses revocation, absolute expiry, and idle expiry as the usable session boundary", () => {
    const where = activeFederatedSessionWhere(cfg, now);
    expect(where).toEqual({
      authenticatedIdpId: { not: null }, revokedAt: null,
      expiresAt: { gt: now }, lastSeenAt: { gt: new Date("2026-10-13T20:50:00Z") },
    });
    const isUsable = (session: { authenticatedIdpId: string | null; revokedAt: Date | null; expiresAt: Date; lastSeenAt: Date }) =>
      session.authenticatedIdpId !== null && session.revokedAt === null &&
      session.expiresAt > now && session.lastSeenAt > new Date("2026-10-13T20:50:00Z");
    expect(isUsable({ authenticatedIdpId: "external", revokedAt: now, expiresAt: new Date("2026-10-14"), lastSeenAt: now })).toBe(false);
    expect(isUsable({ authenticatedIdpId: "external", revokedAt: null, expiresAt: new Date("2026-10-13T20:59:00Z"), lastSeenAt: now })).toBe(false);
    expect(isUsable({ authenticatedIdpId: "external", revokedAt: null, expiresAt: new Date("2026-10-14"), lastSeenAt: new Date("2026-10-13T20:30:00Z") })).toBe(false);
    expect(isUsable({ authenticatedIdpId: "external", revokedAt: null, expiresAt: new Date("2026-10-14"), lastSeenAt: now })).toBe(true);
  });

  it("applies identical usable-session filter to native-only login and rollout readiness", async () => {
    const prisma = {
      identityProvider: { count: vi.fn().mockResolvedValue(0) },
      userIdentity: { count: vi.fn().mockResolvedValue(0) },
      tenantAuthPolicy: { count: vi.fn().mockResolvedValue(0) },
      portalSession: { count: vi.fn().mockResolvedValue(0) },
      tenant: { count: vi.fn().mockResolvedValue(0) },
      tenantOidcProvider: { count: vi.fn().mockResolvedValue(0) },
    };
    const db = prisma as unknown as PrismaService;
    const native = new NativeLoginModeService(cfg, db);
    const rollout = new TenantOidcAutoRolloutService(db,
      { verifyIssuerSecurity: vi.fn() } as unknown as TenantOidcService, cfg);
    expect(await native.isNativeOnly()).toBe(true);
    expect(await rollout.readiness()).toEqual({ status: "ready" });
    const queries = prisma.portalSession.count.mock.calls as unknown as Array<[
      { where: { authenticatedIdpId: { not: null }; revokedAt: null;
        expiresAt: { gt: Date }; lastSeenAt: { gt: Date } } },
    ]>;
    expect(queries).toHaveLength(2);
    for (const [params] of queries) {
      expect(params.where.authenticatedIdpId).toEqual({ not: null });
      expect(params.where.revokedAt).toBeNull();
      expect(params.where.expiresAt.gt).toBeInstanceOf(Date);
      expect(params.where.lastSeenAt.gt).toBeInstanceOf(Date);
    }
    prisma.portalSession.count.mockResolvedValue(1);
    await expect(native.isNativeOnly()).resolves.toBe(false);
    await expect(rollout.readiness()).resolves.toEqual({ status: "blocked" });
  });
});
