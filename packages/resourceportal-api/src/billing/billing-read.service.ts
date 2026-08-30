import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { BillingHistoryQueryDto, UsageHistoryQueryDto } from "./billing.dto";
import { creditsToPln } from "./billing-math";

type TransactionExtra = {
  id: string;
  reason: string | null;
  sourceTransactionId: string | null;
  metadata: Prisma.JsonValue | null;
};

type UsageExtra = {
  id: string;
  chargedCredits: Prisma.Decimal;
  priceListVersionId: string | null;
  appGroupId: string | null;
};

@Injectable()
export class BillingReadService {
  constructor(private readonly prisma: PrismaService) {}

  async listTransactions(tenantId: string, query: BillingHistoryQueryDto) {
    const account = await this.account(tenantId);
    const limit = query.limit ?? 50;
    const rows = await this.prisma.billingTransaction.findMany({
      where: {
        billingAccountId: account.id,
        type: query.type,
        createdAt: this.dateFilter(query.from, query.to),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      cursor: query.cursor ? { id: query.cursor } : undefined,
      skip: query.cursor ? 1 : undefined,
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const extras = await this.transactionExtras(items.map((item) => item.id));

    return {
      items: items.map((item) => {
        const extra = extras.get(item.id);
        return {
          id: item.id,
          billingAccountId: item.billingAccountId,
          type: item.type,
          amountCredits: item.amount.toString(),
          amountPln: creditsToPln(item.amount).toString(),
          balanceBeforeCredits: item.balanceBefore.toString(),
          balanceBeforePln: creditsToPln(item.balanceBefore).toString(),
          balanceAfterCredits: item.balanceAfter.toString(),
          balanceAfterPln: creditsToPln(item.balanceAfter).toString(),
          status: item.status,
          reference: item.reference,
          reason: extra?.reason ?? null,
          sourceTransactionId: extra?.sourceTransactionId ?? null,
          metadata: extra?.metadata ?? null,
          createdAt: item.createdAt,
        };
      }),
      nextCursor: hasMore ? items.at(-1)?.id ?? null : null,
    };
  }

  async listUsageRecords(tenantId: string, query: UsageHistoryQueryDto) {
    const account = await this.account(tenantId);
    const limit = query.limit ?? 50;
    const rows = await this.prisma.usageRecord.findMany({
      where: {
        billingAccountId: account.id,
        resourceType: query.resourceType,
        resourceId: query.resourceId,
        periodStart: this.dateFilter(query.from, query.to),
        usage: query.appGroupId
          ? { path: ["appGroupId"], equals: query.appGroupId }
          : undefined,
      },
      orderBy: [{ periodEnd: "desc" }, { id: "desc" }],
      cursor: query.cursor ? { id: query.cursor } : undefined,
      skip: query.cursor ? 1 : undefined,
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const extras = await this.usageExtras(items.map((item) => item.id));

    return {
      items: items.map((item) => this.mapUsage(item, extras.get(item.id))),
      nextCursor: hasMore ? items.at(-1)?.id ?? null : null,
    };
  }

  async usageSummary(tenantId: string, query: UsageHistoryQueryDto) {
    const account = await this.account(tenantId);
    const rows = await this.prisma.usageRecord.findMany({
      where: {
        billingAccountId: account.id,
        resourceType: query.resourceType,
        resourceId: query.resourceId,
        periodStart: this.dateFilter(query.from, query.to),
        usage: query.appGroupId
          ? { path: ["appGroupId"], equals: query.appGroupId }
          : undefined,
      },
      orderBy: [{ periodStart: "asc" }, { id: "asc" }],
    });
    const extras = await this.usageExtras(rows.map((row) => row.id));
    const totalTheoretical = rows.reduce(
      (sum, row) => sum.plus(row.cost),
      new Prisma.Decimal(0),
    );
    const totalCharged = rows.reduce(
      (sum, row) => sum.plus(extras.get(row.id)?.chargedCredits ?? row.cost),
      new Prisma.Decimal(0),
    );
    const groups = new Map<
      string,
      {
        resourceType: string;
        resourceId: string;
        appGroupId: string | null;
        records: number;
        theoretical: Prisma.Decimal;
        charged: Prisma.Decimal;
      }
    >();

    for (const row of rows) {
      const extra = extras.get(row.id);
      const appGroupId = extra?.appGroupId ?? this.jsonString(row.usage, "appGroupId");
      const key = `${row.resourceType}:${row.resourceId}:${appGroupId ?? "-"}`;
      const group = groups.get(key) ?? {
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        appGroupId,
        records: 0,
        theoretical: new Prisma.Decimal(0),
        charged: new Prisma.Decimal(0),
      };
      group.records += 1;
      group.theoretical = group.theoretical.plus(row.cost);
      group.charged = group.charged.plus(extra?.chargedCredits ?? row.cost);
      groups.set(key, group);
    }

    return {
      tenantId,
      period: { from: query.from ?? null, to: query.to ?? null },
      records: rows.length,
      theoreticalCostCredits: totalTheoretical.toString(),
      theoreticalCostPln: creditsToPln(totalTheoretical).toString(),
      chargedCredits: totalCharged.toString(),
      chargedPln: creditsToPln(totalCharged).toString(),
      resources: [...groups.values()].map((group) => ({
        resourceType: group.resourceType,
        resourceId: group.resourceId,
        appGroupId: group.appGroupId,
        records: group.records,
        theoreticalCostCredits: group.theoretical.toString(),
        theoreticalCostPln: creditsToPln(group.theoretical).toString(),
        chargedCredits: group.charged.toString(),
        chargedPln: creditsToPln(group.charged).toString(),
      })),
    };
  }

  private async account(tenantId: string) {
    const account = await this.prisma.billingAccount.findUnique({
      where: { tenantId },
      select: { id: true },
    });
    if (!account) {
      throw new NotFoundException("Billing account not found");
    }
    return account;
  }

  private async transactionExtras(ids: string[]) {
    if (ids.length === 0) return new Map<string, TransactionExtra>();
    const rows = await this.prisma.$queryRaw<TransactionExtra[]>(Prisma.sql`
      SELECT "id", "reason", "sourceTransactionId", "metadata"
      FROM "BillingTransaction"
      WHERE "id" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
    `);
    return new Map(rows.map((row) => [row.id, row]));
  }

  private async usageExtras(ids: string[]) {
    if (ids.length === 0) return new Map<string, UsageExtra>();
    const rows = await this.prisma.$queryRaw<UsageExtra[]>(Prisma.sql`
      SELECT "id", "chargedCredits", "priceListVersionId", "appGroupId"
      FROM "UsageRecord"
      WHERE "id" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
    `);
    return new Map(rows.map((row) => [row.id, row]));
  }

  private mapUsage(
    row: {
      id: string;
      billingAccountId: string;
      tenantId: string;
      resourceType: string;
      resourceId: string;
      periodStart: Date;
      periodEnd: Date;
      usage: Prisma.JsonValue;
      cost: Prisma.Decimal;
    },
    extra?: UsageExtra,
  ) {
    const charged = extra?.chargedCredits ?? row.cost;
    return {
      id: row.id,
      billingAccountId: row.billingAccountId,
      tenantId: row.tenantId,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      appGroupId: extra?.appGroupId ?? this.jsonString(row.usage, "appGroupId"),
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      priceListVersionId:
        extra?.priceListVersionId ?? this.jsonString(row.usage, "priceListVersionId"),
      usage: row.usage,
      theoreticalCostCredits: row.cost.toString(),
      theoreticalCostPln: creditsToPln(row.cost).toString(),
      chargedCredits: charged.toString(),
      chargedPln: creditsToPln(charged).toString(),
    };
  }

  private jsonString(value: Prisma.JsonValue, key: string) {
    if (!value || Array.isArray(value) || typeof value !== "object") return null;
    const item = value[key];
    return typeof item === "string" ? item : null;
  }

  private dateFilter(from?: string, to?: string) {
    if (!from && !to) return undefined;
    return {
      gte: from ? new Date(from) : undefined,
      lte: to ? new Date(to) : undefined,
    };
  }
}
