import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { BillingService } from "./billing.service";

describe("tenant pricing preview", () => {
  it("provides only the effective public unit rates and excludes billing account data", async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: "private-price-id", version: 7, effectiveFrom: new Date("2026-10-01T00:00:00Z"),
      cpuCreditsPerVcpuHour: new Prisma.Decimal("1.25000000"),
      memoryCreditsPerGbHour: new Prisma.Decimal("0.75000000"),
      gpuCreditsPerGpuHour: new Prisma.Decimal("5.00000000"),
    });
    const billing = new BillingService({ priceListVersion: { findFirst } } as never, {} as never);
    const preview = await billing.getTenantEstimateRates();
    expect(preview).toEqual({
      available: true, version: 7, effectiveFrom: new Date("2026-10-01T00:00:00Z"),
      cpuCreditsPerVcpuHour: "1.25", memoryCreditsPerGbHour: "0.75",
      gpuCreditsPerGpuHour: "5", plnPerCredit: "0.01",
    });
    expect(preview).not.toHaveProperty("id");
    expect(preview).not.toHaveProperty("createdBy");
    const query = findFirst.mock.calls[0]?.[0] as { where: { effectiveFrom: { lte: Date } } };
    expect(query.where.effectiveFrom.lte).toBeInstanceOf(Date);
  });
  it("reports unavailable when no effective pricing exists", async () => {
    const billing = new BillingService({ priceListVersion: { findFirst: vi.fn().mockResolvedValue(null) } } as never, {} as never);
    await expect(billing.getTenantEstimateRates()).resolves.toEqual({ available: false });
  });
});
