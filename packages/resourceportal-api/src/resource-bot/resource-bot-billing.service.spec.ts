/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- Prisma transaction fixture mocks are intentionally untyped. */
import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { ResourceBotBillingService } from "./resource-bot-billing.service";

describe("ResourceBotBillingService", () => {
  const service = new ResourceBotBillingService({} as never);
  const price = {
    inputCreditsPer1M: new Prisma.Decimal("40"),
    cachedInputCreditsPer1M: new Prisma.Decimal("4"),
    outputCreditsPer1M: new Prisma.Decimal("200"),
    embeddingCreditsPer1M: new Prisma.Decimal("2"),
  };

  it("charges cached input at the cached rate and output independently", () => {
    const cost = service.costForUsage(price, {
      inputTokens: 1_000_000,
      cachedInputTokens: 250_000,
      embeddingInputTokens: 0,
      outputTokens: 100_000,
    });
    expect(cost.toString()).toBe("51");
  });

  it("never treats more cached tokens than total input as billable cache", () => {
    const cost = service.costForUsage(price, {
      inputTokens: 100,
      cachedInputTokens: 500,
      embeddingInputTokens: 0,
      outputTokens: 0,
    });
    expect(cost.toString()).toBe("0.0004");
  });

  it("charges query embedding tokens separately from generation input", () => {
    const cost = service.costForUsage(price, {
      inputTokens: 0,
      cachedInputTokens: 0,
      embeddingInputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(cost.toString()).toBe("2");
  });

  it("rounds to the billing ledger precision", () => {
    const cost = service.costForUsage(price, {
      inputTokens: 1,
      cachedInputTokens: 0,
      embeddingInputTokens: 0,
      outputTokens: 1,
    });
    expect(cost.toString()).toBe("0.00024");
  });
});
describe("ResourceBot reservation accounting boundaries", () => {
  const originalPrice = {
    id: "00000000-0000-4000-8000-000000000010",
    provider: "OpenAI",
    model: "example-model",
    inputCreditsPer1M: new Prisma.Decimal(40),
    cachedInputCreditsPer1M: new Prisma.Decimal(4),
    outputCreditsPer1M: new Prisma.Decimal(200),
    embeddingCreditsPer1M: new Prisma.Decimal(2),
  };
  const tenantId = "00000000-0000-4000-8000-000000000020";
  const accountId = "00000000-0000-4000-8000-000000000030";
  const actor = {
    id: "00000000-0000-4000-8000-000000000040",
    displayName: "Example",
  } as never;
  const input = {
    tenantId,
    requestId: "test-request",
    reservationId: "reservation-1",
    actor,
    provider: "OpenAI",
    model: "example-model",
    inputTokens: 1_000_000,
    cachedInputTokens: 0,
    outputTokens: 0,
    embeddingInputTokens: 0,
    totalTokens: 1_000_000,
    supportedByHelp: true,
  };

  function fixture(expiresAt = new Date(Date.now() + 120000)) {
    const account = {
      id: accountId,
      tenantId,
      balance: new Prisma.Decimal(1),
      informationThreshold: new Prisma.Decimal(0),
    };
    const reservation = {
      id: "reservation-1",
      billingAccountId: accountId,
      tenantId,
      requestId: "test-request",
      reservedCredits: new Prisma.Decimal("0.02"),
      expiresAt,
      priceVersionId: originalPrice.id,
      priceVersion: originalPrice,
    };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([account]),
      resourceBotUsageRecord: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ ...data, createdAt: new Date() })),
      },
      resourceBotUsageReservation: {
        findUnique: vi.fn().mockResolvedValue(reservation),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      billingAccount: { update: vi.fn().mockResolvedValue(account) },
      billingTransaction: { create: vi.fn().mockResolvedValue({ id: "bill-1" }) },
      auditLogEntry: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
      tenant: { findUnique: vi.fn().mockResolvedValue({ name: "Example Tenant" }) },
    };
    const prisma = {
      $transaction: vi.fn((callback) => callback(tx)),
      resourceBotPriceVersion: { findFirst: vi.fn() },
      resourceBotUsageReservation: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const service = new ResourceBotBillingService(prisma as never);
    return { service, tx, prisma };
  }

  it("settles against the reserved version, caps cost and never overdraws", async () => {
    const { service, tx, prisma } = fixture();
    const result = await service.settle(input);
    expect(prisma.resourceBotPriceVersion.findFirst).not.toHaveBeenCalled();
    expect(tx.resourceBotUsageRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        priceVersionId: originalPrice.id,
        theoreticalCostCredits: new Prisma.Decimal(40),
        chargedCredits: new Prisma.Decimal("0.02"),
      }),
    });
    expect(result.chargedCredits).toBe("0.02");
    expect(tx.billingAccount.update).toHaveBeenCalledWith({
      where: { id: accountId },
      data: { balance: new Prisma.Decimal("0.98") },
    });
  });

  it("rejects a replaced reservation owned by another in-flight request", async () => {
    const { service, tx } = fixture();
    await expect(service.settle({ ...input, reservationId: "stale-reservation" })).rejects.toThrow("ResourceBot reservation expired");
    expect(tx.billingAccount.update).not.toHaveBeenCalled();
  });

  it("rejects an expired reservation without debiting the tenant", async () => {
    const { service, tx } = fixture(new Date(Date.now() - 1));
    await expect(service.settle(input)).rejects.toThrow("ResourceBot reservation expired");
    expect(tx.billingAccount.update).not.toHaveBeenCalled();
    expect(tx.resourceBotUsageRecord.create).not.toHaveBeenCalled();
  });

  it("renews only an existing unexpired reservation for its tenant", async () => {
    const { service, prisma } = fixture();
    await service.renew("test-request", tenantId, "reservation-1");
    expect(prisma.resourceBotUsageReservation.updateMany).toHaveBeenCalledWith({
      where: { id: "reservation-1", requestId: "test-request", tenantId, expiresAt: { gt: expect.any(Date) } },
      data: { expiresAt: expect.any(Date) },
    });
  });
});