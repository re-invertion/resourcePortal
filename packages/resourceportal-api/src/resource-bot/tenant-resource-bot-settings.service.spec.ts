import { ForbiddenException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { TenantResourceBotSettingsService } from "./tenant-resource-bot-settings.service";

describe("TenantResourceBotSettingsService", () => {
  it("is enabled by default when no tenant override exists", async () => {
    const prisma = {
      tenant: { findUnique: vi.fn().mockResolvedValue({ id: "tenant", name: "Tenant" }) },
      tenantResourceBotSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    const service = new TenantResourceBotSettingsService(
      prisma as never,
      {} as never,
      {} as never,
    );
    await expect(service.getSettings("tenant")).resolves.toEqual({
      enabled: true,
      updatedAt: null,
    });
  });

  it("rejects use when the tenant explicitly disables ResourceBot", async () => {
    const prisma = {
      tenantResourceBotSettings: {
        findUnique: vi.fn().mockResolvedValue({ enabled: false }),
      },
    };
    const service = new TenantResourceBotSettingsService(
      prisma as never,
      {} as never,
      {} as never,
    );
    await expect(service.assertEnabled("tenant")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("reports a usable status only when platform, price and billing are ready", async () => {
    const prisma = {
      tenant: { findUnique: vi.fn().mockResolvedValue({ id: "tenant", name: "Tenant" }) },
      tenantResourceBotSettings: { findUnique: vi.fn().mockResolvedValue(null) },
      billingAccount: {
        findUnique: vi.fn().mockResolvedValue({ balance: new Prisma.Decimal("10") }),
      },
    };
    const platform = {
      getRuntimeState: vi.fn().mockResolvedValue({
        enabled: true,
        configured: true,
        available: true,
        provider: "OpenAI",
        generationModel: "gpt-5.6-luna",
        embeddingModel: "text-embedding-3-small",
        lastValidatedAt: new Date(),
        lastError: null,
      }),
    };
    const billing = { getActivePrice: vi.fn().mockResolvedValue({ id: "price" }) };
    const service = new TenantResourceBotSettingsService(
      prisma as never,
      platform as never,
      billing as never,
    );
    const status = await service.getStatus("tenant");
    expect(status.available).toBe(true);
    expect(status.reason).toBeNull();
    expect(status.priceAvailable).toBe(true);
  });
});
