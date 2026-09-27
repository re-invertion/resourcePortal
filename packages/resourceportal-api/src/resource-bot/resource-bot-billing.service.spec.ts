import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
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
