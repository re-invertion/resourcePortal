import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { AuthenticatedUser } from "../auth/types";
import { PrismaService } from "../prisma/prisma.service";

type LockedBillingAccount = {
  id: string;
  tenantId: string;
  balance: Prisma.Decimal;
  informationThreshold: Prisma.Decimal;
};

const RESERVATION_TTL_MS = 5 * 60_000;
const RESERVATION_MAX_INPUT_TOKENS = 50_000;
const RESERVATION_MAX_OUTPUT_TOKENS = 700;
const RESERVATION_MAX_EMBEDDING_INPUT_TOKENS = 5_000;
const TOKENS_PER_MILLION = new Prisma.Decimal(1_000_000);

@Injectable()
export class ResourceBotBillingService {
  constructor(private readonly prisma: PrismaService) {}

  async getActivePrice(provider: string, model: string, at = new Date()) {
    const price = await this.prisma.resourceBotPriceVersion.findFirst({
      where: {
        provider,
        model,
        effectiveFrom: { lte: at },
      },
      orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
    });
    if (!price) {
      throw new ConflictException({
        code: "ResourceBotPriceUnavailable",
        message: "No active ResourceBot price is configured for " + provider + "/" + model,
      });
    }
    return price;
  }

  async listPrices() {
    const rows = await this.prisma.resourceBotPriceVersion.findMany({
      orderBy: [
        { effectiveFrom: "desc" },
        { createdAt: "desc" },
      ],
    });
    return {
      items: rows.map((row) => ({
        id: row.id,
        provider: row.provider,
        model: row.model,
        effectiveFrom: row.effectiveFrom,
        inputCreditsPer1M: row.inputCreditsPer1M.toString(),
        cachedInputCreditsPer1M: row.cachedInputCreditsPer1M.toString(),
        outputCreditsPer1M: row.outputCreditsPer1M.toString(),
        embeddingCreditsPer1M: row.embeddingCreditsPer1M.toString(),
        createdBy: row.createdBy,
        createdAt: row.createdAt,
      })),
    };
  }

  async createPrice(
    input: {
      provider: string;
      model: string;
      effectiveFrom: string;
      inputCreditsPer1M: string;
      cachedInputCreditsPer1M: string;
      outputCreditsPer1M: string;
      embeddingCreditsPer1M: string;
    },
    actor: AuthenticatedUser,
  ) {
    const effectiveFrom = new Date(input.effectiveFrom);
    if (
      Number.isNaN(effectiveFrom.getTime()) ||
      effectiveFrom.getUTCSeconds() !== 0 ||
      effectiveFrom.getUTCMilliseconds() !== 0
    ) {
      throw new BadRequestException(
        "ResourceBot price effectiveFrom must be aligned to a full minute",
      );
    }
    const rates = {
      input: this.nonNegativeRate(input.inputCreditsPer1M, "inputCreditsPer1M"),
      cached: this.nonNegativeRate(
        input.cachedInputCreditsPer1M,
        "cachedInputCreditsPer1M",
      ),
      output: this.nonNegativeRate(input.outputCreditsPer1M, "outputCreditsPer1M"),
      embedding: this.nonNegativeRate(
        input.embeddingCreditsPer1M,
        "embeddingCreditsPer1M",
      ),
    };
    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.resourceBotPriceVersion.create({
          data: {
            provider: input.provider,
            model: input.model,
            effectiveFrom,
            inputCreditsPer1M: rates.input,
            cachedInputCreditsPer1M: rates.cached,
            outputCreditsPer1M: rates.output,
            embeddingCreditsPer1M: rates.embedding,
            createdBy: actor.id,
          },
        });
        await tx.auditLogEntry.create({
          data: {
            tenantId: null,
            tenantName: "Platform",
            actor: actor.id,
            actorName: actor.displayName,
            action: "platform.resourcebot.price.create",
            resourceType: "ResourceBotPriceVersion",
            resourceId: row.id,
            resourceName: input.provider + "/" + input.model,
            result: "Success",
            correlationId: randomUUID(),
            changes: {
              provider: input.provider,
              model: input.model,
              effectiveFrom: effectiveFrom.toISOString(),
              inputCreditsPer1M: rates.input.toString(),
              cachedInputCreditsPer1M: rates.cached.toString(),
              outputCreditsPer1M: rates.output.toString(),
              embeddingCreditsPer1M: rates.embedding.toString(),
            },
          },
        });
        return {
          id: row.id,
          provider: row.provider,
          model: row.model,
          effectiveFrom: row.effectiveFrom,
          inputCreditsPer1M: row.inputCreditsPer1M.toString(),
          cachedInputCreditsPer1M: row.cachedInputCreditsPer1M.toString(),
          outputCreditsPer1M: row.outputCreditsPer1M.toString(),
          embeddingCreditsPer1M: row.embeddingCreditsPer1M.toString(),
          createdBy: row.createdBy,
          createdAt: row.createdAt,
        };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new ConflictException(
          "A ResourceBot price already exists for this provider, model and effective time",
        );
      }
      throw error;
    }
  }

  async reserve(input: {
    tenantId: string;
    requestId: string;
    provider: string;
    model: string;
  }) {
    const price = await this.getActivePrice(input.provider, input.model);
    const reservedCredits = this.costForUsage(price, {
      inputTokens: RESERVATION_MAX_INPUT_TOKENS,
      cachedInputTokens: 0,
      outputTokens: RESERVATION_MAX_OUTPUT_TOKENS,
      embeddingInputTokens: RESERVATION_MAX_EMBEDDING_INPUT_TOKENS,
    });

    return this.prisma.$transaction(async (tx) => {
      const account = await this.lockAccount(tx, input.tenantId);
      const existingUsage = await tx.resourceBotUsageRecord.findUnique({
        where: { requestId: input.requestId },
        select: { id: true, chargedCredits: true },
      });
      if (existingUsage) {
        return {
          duplicate: true as const,
          usageRecordId: existingUsage.id,
          reservedCredits: new Prisma.Decimal(0),
        };
      }

      await tx.resourceBotUsageReservation.deleteMany({
        where: {
          billingAccountId: account.id,
          expiresAt: { lte: new Date() },
        },
      });

      const existingReservation =
        await tx.resourceBotUsageReservation.findUnique({
          where: { requestId: input.requestId },
        });
      if (existingReservation) {
        return {
          duplicate: false as const,
          reservationId: existingReservation.id,
          reservedCredits: existingReservation.reservedCredits,
        };
      }

      const activeWhere = {
        billingAccountId: account.id,
        expiresAt: { gt: new Date() },
      };
      const [aggregate, activeReservationCount] = await Promise.all([
        tx.resourceBotUsageReservation.aggregate({
          where: activeWhere,
          _sum: { reservedCredits: true },
        }),
        tx.resourceBotUsageReservation.count({ where: activeWhere }),
      ]);
      if (activeReservationCount >= 4) {
        throw new ConflictException({
          code: "ResourceBotRateLimited",
          message: "Too many ResourceBot requests are already running for this tenant",
        });
      }
      const alreadyReserved =
        aggregate._sum.reservedCredits ?? new Prisma.Decimal(0);
      const available = account.balance.minus(alreadyReserved);

      if (account.balance.lte(0)) {
        throw new ConflictException({
          code: "ResourceBotBillingSuspended",
          message: "ResourceBot is unavailable while tenant billing is suspended",
        });
      }
      if (available.lt(reservedCredits)) {
        throw new ConflictException({
          code: "ResourceBotUsageLimitExceeded",
          message: "Tenant balance is too low to reserve this ResourceBot request",
        });
      }

      const reservation = await tx.resourceBotUsageReservation.create({
        data: {
          billingAccountId: account.id,
          tenantId: input.tenantId,
          requestId: input.requestId,
          reservedCredits,
          expiresAt: new Date(Date.now() + RESERVATION_TTL_MS),
        },
      });
      return {
        duplicate: false as const,
        reservationId: reservation.id,
        reservedCredits,
      };
    });
  }

  async settle(input: {
    tenantId: string;
    requestId: string;
    actor: AuthenticatedUser;
    provider: string;
    model: string;
    providerRequestId?: string;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    embeddingInputTokens: number;
    totalTokens: number;
    supportedByHelp: boolean;
  }) {
    const price = await this.getActivePrice(input.provider, input.model);
    const theoreticalCost = this.costForUsage(price, input);

    return this.prisma.$transaction(async (tx) => {
      const account = await this.lockAccount(tx, input.tenantId);
      const existing = await tx.resourceBotUsageRecord.findUnique({
        where: { requestId: input.requestId },
      });
      if (existing) {
        await tx.resourceBotUsageReservation.deleteMany({
          where: { requestId: input.requestId },
        });
        return this.toUsageView(existing);
      }

      const tenant = await tx.tenant.findUnique({
        where: { id: input.tenantId },
        select: { name: true },
      });
      if (!tenant) throw new NotFoundException("Tenant not found");

      const usageRecordId = randomUUID();
      const balanceBefore = account.balance;
      const balanceAfter = balanceBefore.minus(theoreticalCost);

      const usage = await tx.resourceBotUsageRecord.create({
        data: {
          id: usageRecordId,
          billingAccountId: account.id,
          tenantId: input.tenantId,
          userId: input.actor.id,
          provider: input.provider,
          model: input.model,
          providerRequestId: input.providerRequestId ?? null,
          inputTokens: Math.max(0, Math.floor(input.inputTokens)),
          cachedInputTokens: Math.max(0, Math.floor(input.cachedInputTokens)),
          outputTokens: Math.max(0, Math.floor(input.outputTokens)),
          embeddingInputTokens: Math.max(0, Math.floor(input.embeddingInputTokens)),
          totalTokens: Math.max(0, Math.floor(input.totalTokens)),
          priceVersionId: price.id,
          theoreticalCostCredits: theoreticalCost,
          chargedCredits: theoreticalCost,
          status: "Succeeded",
          requestId: input.requestId,
        },
      });

      await tx.billingAccount.update({
        where: { id: account.id },
        data: { balance: balanceAfter },
      });

      const transaction = await tx.billingTransaction.create({
        data: {
          billingAccountId: account.id,
          type: "UsageCharge",
          amount: theoreticalCost.neg(),
          balanceBefore,
          balanceAfter,
          status: "Succeeded",
          reference: "resourcebot:" + usageRecordId,
          metadata: {
            resourceType: "ResourceBot",
            usageRecordId,
            requestId: input.requestId,
            provider: input.provider,
            model: input.model,
            inputTokens: input.inputTokens,
            cachedInputTokens: input.cachedInputTokens,
            outputTokens: input.outputTokens,
            embeddingInputTokens: input.embeddingInputTokens,
            totalTokens: input.totalTokens,
            priceVersionId: price.id,
            supportedByHelp: input.supportedByHelp,
          },
        },
      });

      await tx.resourceBotUsageReservation.deleteMany({
        where: { requestId: input.requestId },
      });

      await tx.auditLogEntry.create({
        data: {
          tenantId: input.tenantId,
          tenantName: tenant.name,
          actor: input.actor.id,
          actorName: input.actor.displayName,
          action: "resourcebot.usage.charge",
          resourceType: "ResourceBotUsageRecord",
          resourceId: usageRecordId,
          resourceName: "ResourceBot request",
          result: "Success",
          correlationId: randomUUID(),
          changes: {
            transactionId: transaction.id,
            requestId: input.requestId,
            provider: input.provider,
            model: input.model,
            inputTokens: input.inputTokens,
            cachedInputTokens: input.cachedInputTokens,
            outputTokens: input.outputTokens,
            embeddingInputTokens: input.embeddingInputTokens,
            totalTokens: input.totalTokens,
            chargedCredits: theoreticalCost.toString(),
            balanceBeforeCredits: balanceBefore.toString(),
            balanceAfterCredits: balanceAfter.toString(),
            supportedByHelp: input.supportedByHelp,
          },
        },
      });

      return this.toUsageView(usage);
    });
  }

  async release(requestId: string) {
    await this.prisma.resourceBotUsageReservation.deleteMany({
      where: { requestId },
    });
  }

  async listUsage(tenantId: string, limit = 50) {
    const items = await this.prisma.resourceBotUsageRecord.findMany({
      where: { tenantId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: Math.max(1, Math.min(limit, 100)),
    });
    return {
      items: items.map((item) => this.toUsageView(item)),
    };
  }

  costForUsage(
    price: {
      inputCreditsPer1M: Prisma.Decimal;
      cachedInputCreditsPer1M: Prisma.Decimal;
      outputCreditsPer1M: Prisma.Decimal;
      embeddingCreditsPer1M: Prisma.Decimal;
    },
    usage: {
      inputTokens: number;
      cachedInputTokens: number;
      outputTokens: number;
      embeddingInputTokens: number;
    },
  ) {
    const inputTokens = new Prisma.Decimal(
      Math.max(0, Math.floor(usage.inputTokens)),
    );
    const cachedInputTokens = Prisma.Decimal.min(
      inputTokens,
      new Prisma.Decimal(Math.max(0, Math.floor(usage.cachedInputTokens))),
    );
    const uncachedInputTokens = inputTokens.minus(cachedInputTokens);
    const outputTokens = new Prisma.Decimal(
      Math.max(0, Math.floor(usage.outputTokens)),
    );
    const embeddingInputTokens = new Prisma.Decimal(
      Math.max(0, Math.floor(usage.embeddingInputTokens)),
    );

    return uncachedInputTokens
      .mul(price.inputCreditsPer1M)
      .plus(cachedInputTokens.mul(price.cachedInputCreditsPer1M))
      .plus(outputTokens.mul(price.outputCreditsPer1M))
      .plus(embeddingInputTokens.mul(price.embeddingCreditsPer1M))
      .div(TOKENS_PER_MILLION)
      .toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP);
  }

  private nonNegativeRate(value: string, field: string) {
    const rate = new Prisma.Decimal(value);
    if (rate.lt(0)) {
      throw new BadRequestException(field + " cannot be negative");
    }
    return rate;
  }

  private async lockAccount(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<LockedBillingAccount> {
    const rows = await tx.$queryRaw<LockedBillingAccount[]>(Prisma.sql`\n      SELECT "id", "tenantId", "balance", "informationThreshold"\n      FROM "BillingAccount"\n      WHERE "tenantId" = ${tenantId}::uuid\n      FOR UPDATE\n    `);
    const account = rows[0];
    if (!account) throw new NotFoundException("Billing account not found");
    return account;
  }

  private toUsageView(row: {
    id: string;
    tenantId: string;
    userId: string;
    provider: string;
    model: string;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    embeddingInputTokens: number;
    totalTokens: number;
    theoreticalCostCredits: Prisma.Decimal;
    chargedCredits: Prisma.Decimal;
    status: string;
    requestId: string;
    createdAt: Date;
  }) {
    return {
      id: row.id,
      tenantId: row.tenantId,
      userId: row.userId,
      provider: row.provider,
      model: row.model,
      inputTokens: row.inputTokens,
      cachedInputTokens: row.cachedInputTokens,
      outputTokens: row.outputTokens,
      embeddingInputTokens: row.embeddingInputTokens,
      totalTokens: row.totalTokens,
      theoreticalCostCredits: row.theoreticalCostCredits.toString(),
      chargedCredits: row.chargedCredits.toString(),
      status: row.status,
      requestId: row.requestId,
      createdAt: row.createdAt,
    };
  }
}
