import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import { BillingUsageService } from "./billing-usage.service";

type AuditCreateInput = {
  data: Record<string, unknown>;
};

describe("BillingUsageService system audit", () => {
  it("records billing worker activity with actor=system and a readable actorName", async () => {
    const tenantId = "11111111-1111-4111-8111-111111111111";
    const usageRecordId = "22222222-2222-4222-8222-222222222222";
    const accountId = "33333333-3333-4333-8333-333333333333";
    const transactionId = "44444444-4444-4444-8444-444444444444";
    const auditCreate = vi.fn((input: AuditCreateInput) => Promise.resolve(input));
    const tx = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ id: usageRecordId }])
        .mockResolvedValueOnce([
          {
            id: accountId,
            tenantId,
            balance: new Prisma.Decimal("10"),
          },
        ]),
      $executeRaw: vi.fn(() => Promise.resolve(1)),
      billingAccount: {
        update: vi.fn(() => Promise.resolve({ id: accountId })),
      },
      billingTransaction: {
        create: vi.fn(() => Promise.resolve({ id: transactionId })),
      },
      auditLogEntry: { create: auditCreate },
    };
    const prisma = {
      tenant: {
        findUnique: vi.fn(() => Promise.resolve({ name: "tenant" })),
      },
      $transaction: vi.fn((callback: (client: typeof tx) => Promise<unknown>) =>
        callback(tx),
      ),
    };
    const service = new BillingUsageService(prisma as unknown as PrismaService);

    await service.recordUsageCharge({
      tenantId,
      resourceType: "SingleApp",
      resourceId: "55555555-5555-4555-8555-555555555555",
      appGroupId: "66666666-6666-4666-8666-666666666666",
      periodStart: new Date("2026-08-30T12:00:00Z"),
      periodEnd: new Date("2026-08-30T12:01:00Z"),
      usage: { billedReplicas: 1 },
      theoreticalCost: new Prisma.Decimal("1"),
      priceListVersionId: "77777777-7777-4777-8777-777777777777",
      allowDebt: false,
    });

    expect(auditCreate.mock.calls[0]?.[0]?.data).toMatchObject({
      tenantId,
      actor: "system",
      actorName: "Billing Worker",
      action: "billing.usage_charge",
      result: "Success",
    });
  });
});
