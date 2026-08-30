import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { clampComputeCharge } from "./billing-math";

type LockedBillingAccount = {
  id: string;
  tenantId: string;
  balance: Prisma.Decimal;
};

@Injectable()
export class BillingUsageService {
  constructor(private readonly prisma: PrismaService) {}

  async recordUsageCharge(input: {
    tenantId: string;
    resourceType: "SingleApp" | "Volume";
    resourceId: string;
    appGroupId?: string;
    periodStart: Date;
    periodEnd: Date;
    usage: Prisma.InputJsonObject;
    theoreticalCost: Prisma.Decimal;
    priceListVersionId: string;
    allowDebt: boolean;
  }) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: input.tenantId },
      select: { name: true },
    });
    if (!tenant) throw new NotFoundException("Tenant not found");

    return this.prisma.$transaction(async (tx) => {
      const usageRecordId = randomUUID();
      const inserted = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        INSERT INTO "UsageRecord" (
          "id", "billingAccountId", "tenantId", "resourceType", "resourceId",
          "periodStart", "periodEnd", "usage", "cost", "chargedCredits",
          "priceListVersionId", "appGroupId"
        )
        SELECT
          ${usageRecordId}::uuid, ba."id", ${input.tenantId}::uuid,
          ${input.resourceType}, ${input.resourceId}::uuid, ${input.periodStart},
          ${input.periodEnd}, ${JSON.stringify(input.usage)}::jsonb,
          ${input.theoreticalCost}, 0, ${input.priceListVersionId}::uuid,
          ${input.appGroupId ?? null}::uuid
        FROM "BillingAccount" ba
        WHERE ba."tenantId" = ${input.tenantId}::uuid
        ON CONFLICT ("resourceType", "resourceId", "periodStart", "periodEnd")
        DO NOTHING
        RETURNING "id"
      `);

      if (!inserted[0]) {
        return { duplicate: true, usageRecordId: null, chargedCredits: "0" };
      }

      const accountRows = await tx.$queryRaw<LockedBillingAccount[]>`
        SELECT "id", "tenantId", "balance"
        FROM "BillingAccount"
        WHERE "tenantId" = ${input.tenantId}::uuid
        FOR UPDATE
      `;
      const account = accountRows[0];
      if (!account) throw new NotFoundException("Billing account not found");

      const chargedCredits = input.allowDebt
        ? input.theoreticalCost
        : clampComputeCharge(input.theoreticalCost, account.balance);

      await tx.$executeRaw`
        UPDATE "UsageRecord"
        SET "chargedCredits" = ${chargedCredits}
        WHERE "id" = ${usageRecordId}::uuid
      `;

      if (chargedCredits.gt(0)) {
        const balanceBefore = account.balance;
        const balanceAfter = balanceBefore.minus(chargedCredits);
        await tx.billingAccount.update({
          where: { id: account.id },
          data: { balance: balanceAfter },
        });
        const transaction = await tx.billingTransaction.create({
          data: {
            billingAccountId: account.id,
            type: "UsageCharge",
            amount: chargedCredits.neg(),
            balanceBefore,
            balanceAfter,
            status: "Completed",
            reference: `usage:${usageRecordId}`,
          },
        });
        await tx.$executeRaw`
          UPDATE "BillingTransaction"
          SET "metadata" = ${JSON.stringify({
            usageRecordId,
            priceListVersionId: input.priceListVersionId,
            resourceType: input.resourceType,
            resourceId: input.resourceId,
            appGroupId: input.appGroupId ?? null,
            theoreticalCostCredits: input.theoreticalCost.toString(),
            chargedCredits: chargedCredits.toString(),
            actor: "system:billing-worker",
          })}::jsonb
          WHERE "id" = ${transaction.id}::uuid
        `;
      }

      await tx.auditLogEntry.create({
        data: {
          tenantId: input.tenantId,
          tenantName: tenant.name,
          actor: "system:billing-worker",
          actorName: "Billing Worker",
          action: "billing.usage_charge",
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          result: "Success",
          correlationId: randomUUID(),
          changes: {
            usageRecordId,
            priceListVersionId: input.priceListVersionId,
            theoreticalCostCredits: input.theoreticalCost.toString(),
            chargedCredits: chargedCredits.toString(),
          },
        },
      });

      if (account.balance.gt(0) && account.balance.minus(chargedCredits).lte(0)) {
        await tx.auditLogEntry.create({
          data: {
            tenantId: input.tenantId,
            tenantName: tenant.name,
            actor: "system:billing-worker",
            actorName: "Billing Worker",
            action: "billing.suspend",
            resourceType: "BillingAccount",
            resourceId: account.id,
            result: "Success",
            correlationId: randomUUID(),
            changes: {
              balanceBeforeCredits: account.balance.toString(),
              balanceAfterCredits: account.balance.minus(chargedCredits).toString(),
            },
          },
        });
      }

      return {
        duplicate: false,
        usageRecordId,
        chargedCredits: chargedCredits.toString(),
      };
    });
  }
}
