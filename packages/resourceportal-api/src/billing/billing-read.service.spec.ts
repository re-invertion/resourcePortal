import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import { BillingReadService } from "./billing-read.service";
import { UsageSeriesQueryDto } from "./billing.dto";

describe("BillingReadService usage series", () => {
  it("maps aggregated buckets into the chart data shape", async () => {
    const periodStart = new Date("2026-09-26T10:00:00.000Z");
    const queryRaw = vi.fn().mockResolvedValue([{
      periodStart,
      chargedCredits: new Prisma.Decimal("3"),
      theoreticalCostCredits: new Prisma.Decimal("4"),
      billedReplicas: new Prisma.Decimal("1.5"),
      desiredReplicas: new Prisma.Decimal("2.5"),
      sampleCount: 120,
    }]);
    const prisma = {
      billingAccount: {
        findUnique: vi.fn().mockResolvedValue({ id: "11111111-1111-4111-8111-111111111111" }),
      },
      $queryRaw: queryRaw,
    };
    const service = new BillingReadService(prisma as unknown as PrismaService);
    const query = Object.assign(new UsageSeriesQueryDto(), {
      bucket: "15m" as const,
      from: "2026-09-26T00:00:00.000Z",
    });

    const result = await service.usageSeries("22222222-2222-4222-8222-222222222222", query);

    expect(result).toEqual({
      bucket: "15m",
      items: [{
        id: `series-0-${periodStart.toISOString()}`,
        periodStart,
        chargedCredits: "3",
        chargedPln: "0.03",
        theoreticalCostCredits: "4",
        theoreticalCostPln: "0.04",
        usage: {
          billedReplicas: 1.5,
          desiredReplicas: 2.5,
          sampleCount: 120,
        },
      }],
    });
    expect(queryRaw).toHaveBeenCalledOnce();
  });
});
