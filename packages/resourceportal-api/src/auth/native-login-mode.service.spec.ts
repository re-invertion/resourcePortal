import { ConfigService } from "@nestjs/config";
import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../prisma/prisma.service";
import { NativeLoginModeService } from "./native-login-mode.service";

function fixture(mode: string, issuer = "https://auth.example.com") {
  const config = { get: (key: string) => ({
    RP_NATIVE_LOGIN_ONLY: mode,
    OIDC_ISSUER_URL: issuer,
  } as Record<string, string>)[key] };
  const prisma = {
    identityProvider: { count: vi.fn().mockResolvedValue(0) },
    userIdentity: { count: vi.fn().mockResolvedValue(0) },
    tenantAuthPolicy: { count: vi.fn().mockResolvedValue(0) },
    portalSession: { count: vi.fn().mockResolvedValue(0) },
  };
  return {
    prisma,
    service: new NativeLoginModeService(
      config as ConfigService,
      prisma as unknown as PrismaService,
    ),
  };
}

describe("Automatic native ResourcePortal login mode", () => {
  it("automatically disables RP inbound federation if none was configured", async () => {
    const { service } = fixture("auto");
    await expect(service.isNativeOnly()).resolves.toBe(true);
  });

  it.each(["identityProvider", "userIdentity", "tenantAuthPolicy", "portalSession"] as const)(
    "leaves legacy federation accessible if %s contains records",
    async (table) => {
      const f = fixture("auto");
      f.prisma[table].count.mockResolvedValue(1);
      await expect(f.service.isNativeOnly()).resolves.toBe(false);
    },
  );

  it("does not turn on native-only mode without a configured HTTPS issuer", async () => {
    await expect(fixture("auto", "http://auth.example.com").service.isNativeOnly())
      .resolves.toBe(false);
  });

  it("respects explicit false without querying the database", async () => {
    const f = fixture("false");
    await expect(f.service.isNativeOnly()).resolves.toBe(false);
    expect(f.prisma.identityProvider.count).not.toHaveBeenCalled();
  });

  it("respects explicit operator-controlled native-only true", async () => {
    await expect(fixture("true").service.isNativeOnly()).resolves.toBe(true);
  });

  it("fails closed on an unavailable database instead of guessing the login mode", async () => {
    const f = fixture("auto");
    f.prisma.identityProvider.count.mockRejectedValue(new Error("Database offline"));
    await expect(f.service.isNativeOnly()).rejects.toThrow("Database offline");
  });
});
