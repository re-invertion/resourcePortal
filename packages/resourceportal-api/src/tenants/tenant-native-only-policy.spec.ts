import { describe, expect, it, vi } from "vitest";
import { TenantsService } from "./tenants.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { PlatformEmailService } from "../email/platform-email.service";
import type { NativeLoginModeService } from "../auth/native-login-mode.service";

describe("Legacy tenant federation policy after automatic native cutover", () => {
  it("rejects requirements for an inbound IdP before database mutation", async () => {
    const prisma = { $transaction: vi.fn() };
    const nativeMode = { isNativeOnly: vi.fn().mockResolvedValue(true) };
    const service = new TenantsService(
      prisma as unknown as PrismaService,
      {} as PlatformEmailService,
      undefined,
      nativeMode as unknown as NativeLoginModeService,
    );
    await expect(service.updateAuthPolicy("tenant-a", {
      requireTenantIdentityProvider: true,
    }, {} as never)).rejects.toThrow("retired");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it("does not allow disabling native login after automatic cutover", async () => {
    const nativeMode = { isNativeOnly: vi.fn().mockResolvedValue(true) };
    const service = new TenantsService(
      {} as PrismaService,
      {} as PlatformEmailService,
      undefined,
      nativeMode as unknown as NativeLoginModeService,
    );
    await expect(service.updateAuthPolicy("tenant-a", {
      allowPlatformLogin: false,
    }, {} as never)).rejects.toThrow("retired");
  });
});
