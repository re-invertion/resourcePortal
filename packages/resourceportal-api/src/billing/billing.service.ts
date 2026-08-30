import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuthenticatedUser } from "../auth/types";
import { PrismaService } from "../prisma/prisma.service";
import {
  BillingHistoryQueryDto,
  CreatePriceListDto,
  CreateVoucherDto,
  PlatformBalanceMutationDto,
  UsageHistoryQueryDto,
} from "./billing.dto";
import {
  assertFullMinute,
  clampComputeCharge,
  creditsToPln,
} from "./billing-math";
import {
  BillingLedgerType,
  billingState,
  generateVoucherCode,
  hashVoucherCode,
  isVoucherRedeemable,
  normalizeLedgerAmount,
} from "./billing-policy";

type PriceListRow = {
  id: string;
  version: number;
  effectiveFrom: Date;
  cpuCreditsPerVcpuHour: Prisma.Decimal;
  memoryCreditsPerGbHour: Prisma.Decimal;
  storageCreditsPerGbHour: Prisma.Decimal;
  gpuCreditsPerGpuHour: Prisma.Decimal;
  createdBy: string;
  createdAt: Date;
};

type VoucherRow = {
  id: string;
  codeHash: string;
  valueCredits: Prisma.Decimal;
  status: string;
  expiresAt: Date | null;
  redeemedAt: Date | null;
  redeemedByUserId: string | null;
  redeemedBillingAccountId: string | null;
  disabledAt: Date | null;
  disabledByUserId: string | null;
  createdBy: string;
  createdAt: Date;
};

type LockedBillingAccount = {
  id: string;
  tenantId: string;
  balance: Prisma.Decimal;
  currency: string;
  informationThreshold: Prisma.Decimal;
};

type ActorSnapshot = {
  id: string;
  displayName: string;
};

@Injectable()
export class BillingService {
  constructor(private readonly prisma: PrismaService) {}

  async getAccount(tenantId: string) {
    const account = await this.prisma.billingAccount.findUnique({
      where: { tenantId },
    });

    if (!account) {
      throw new NotFoundException("Billing account not found");
    }

    return this.mapAccount(account);
  }

  async listTransactions(tenantId: string, query: BillingHistoryQueryDto) {
    const account = await this.findAccountOrThrow(tenantId);
    const limit = query.limit ?? 50;
    const createdAt = this.dateFilter(query.from, query.to);
    const transactions = await this.prisma.billingTransaction.findMany({
      where: {
        billingAccountId: account.id,
        type: query.type,
        createdAt,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      cursor: query.cursor ? { id: query.cursor } : undefined,
      skip: query.cursor ? 1 : undefined,
      take: limit + 1,
    });
    const hasMore = transactions.length > limit;
    const items = transactions.slice(0, limit);

    return {
      items: items.map((transaction) => this.mapTransaction(transaction)),
      nextCursor: hasMore ? items.at(-1)?.id ?? null : null,
    };
  }

  async listUsageRecords(tenantId: string, query: UsageHistoryQueryDto) {
    const account = await this.findAccountOrThrow(tenantId);
    const limit = query.limit ?? 50;
    const periodStart = this.dateFilter(query.from, query.to);
    const records = await this.prisma.usageRecord.findMany({
      where: {
        billingAccountId: account.id,
        resourceType: query.resourceType,
        resourceId: query.resourceId,
        periodStart,
      },
      orderBy: [{ periodEnd: "desc" }, { id: "desc" }],
      cursor: query.cursor ? { id: query.cursor } : undefined,
      skip: query.cursor ? 1 : undefined,
      take: limit + 1,
    });
    const hasMore = records.length > limit;
    const items = records.slice(0, limit);

    return {
      items: items.map((record) => this.mapUsageRecord(record)),
      nextCursor: hasMore ? items.at(-1)?.id ?? null : null,
    };
  }

  async usageSummary(tenantId: string, query: UsageHistoryQueryDto) {
    const account = await this.findAccountOrThrow(tenantId);
    const grouped = await this.prisma.usageRecord.groupBy({
      by: ["resourceType"],
      where: {
        billingAccountId: account.id,
        resourceType: query.resourceType,
        resourceId: query.resourceId,
        periodStart: this.dateFilter(query.from, query.to),
      },
      _sum: { cost: true },
      _count: { _all: true },
    });
    const totalCredits = grouped.reduce(
      (sum, item) => sum.plus(item._sum.cost ?? 0),
      new Prisma.Decimal(0),
    );

    return {
      tenantId,
      totalCostCredits: totalCredits.toString(),
      totalCostPln: creditsToPln(totalCredits).toString(),
      byResourceType: grouped.map((item) => ({
        resourceType: item.resourceType,
        records: item._count._all,
        costCredits: (item._sum.cost ?? new Prisma.Decimal(0)).toString(),
        costPln: creditsToPln(item._sum.cost ?? new Prisma.Decimal(0)).toString(),
      })),
    };
  }

  async getActivePriceList(at = new Date()) {
    const rows = await this.prisma.$queryRaw<PriceListRow[]>`
      SELECT * FROM "PriceListVersion"
      WHERE "effectiveFrom" <= ${at}
      ORDER BY "effectiveFrom" DESC, "version" DESC
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async assertActivePriceList(at = new Date()) {
    const priceList = await this.getActivePriceList(at);
    if (!priceList) {
      throw new ConflictException("BillingPriceListUnavailable");
    }
    return priceList;
  }

  async listPriceLists() {
    const rows = await this.prisma.$queryRaw<PriceListRow[]>`
      SELECT * FROM "PriceListVersion"
      ORDER BY "effectiveFrom" DESC, "version" DESC
    `;
    return rows.map((row) => this.mapPriceList(row));
  }

  async getPriceList(priceListId: string) {
    const rows = await this.prisma.$queryRaw<PriceListRow[]>`
      SELECT * FROM "PriceListVersion" WHERE "id" = ${priceListId}::uuid LIMIT 1
    `;
    const row = rows[0];
    if (!row) {
      throw new NotFoundException("Price list not found");
    }
    return this.mapPriceList(row);
  }

  async createPriceList(dto: CreatePriceListDto, actor: AuthenticatedUser) {
    const effectiveFrom = new Date(dto.effectiveFrom);
    assertFullMinute(effectiveFrom);
    const rates = {
      cpu: this.nonNegativeDecimal(dto.cpuCreditsPerVcpuHour, "cpuCreditsPerVcpuHour"),
      memory: this.nonNegativeDecimal(
        dto.memoryCreditsPerGbHour,
        "memoryCreditsPerGbHour",
      ),
      storage: this.nonNegativeDecimal(
        dto.storageCreditsPerGbHour,
        "storageCreditsPerGbHour",
      ),
      gpu: this.nonNegativeDecimal(dto.gpuCreditsPerGpuHour, "gpuCreditsPerGpuHour"),
    };

    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(1010010)`;
      const versions = await tx.$queryRaw<Array<{ version: number }>>`
        SELECT COALESCE(MAX("version"), 0)::int AS "version" FROM "PriceListVersion"
      `;
      const version = (versions[0]?.version ?? 0) + 1;
      const id = randomUUID();
      const rows = await tx.$queryRaw<PriceListRow[]>`
        INSERT INTO "PriceListVersion" (
          "id", "version", "effectiveFrom", "cpuCreditsPerVcpuHour",
          "memoryCreditsPerGbHour", "storageCreditsPerGbHour",
          "gpuCreditsPerGpuHour", "createdBy"
        ) VALUES (
          ${id}::uuid, ${version}, ${effectiveFrom}, ${rates.cpu},
          ${rates.memory}, ${rates.storage}, ${rates.gpu}, ${actor.id}
        ) RETURNING *
      `;
      const row = rows[0];
      if (!row) {
        throw new ConflictException("Price list creation failed");
      }
      await tx.auditLogEntry.create({
        data: {
          tenantName: "Platform",
          actor: actor.id,
          actorName: actor.displayName,
          action: "billing.price_list.create",
          resourceType: "PriceListVersion",
          resourceId: id,
          resourceName: `v${version}`,
          result: "Success",
          correlationId: randomUUID(),
          changes: {
            version,
            effectiveFrom: effectiveFrom.toISOString(),
            cpuCreditsPerVcpuHour: rates.cpu.toString(),
            memoryCreditsPerGbHour: rates.memory.toString(),
            storageCreditsPerGbHour: rates.storage.toString(),
            gpuCreditsPerGpuHour: rates.gpu.toString(),
          },
        },
      });
      return row;
    });

    return this.mapPriceList(created);
  }

  async listVouchers() {
    const rows = await this.prisma.$queryRaw<VoucherRow[]>`
      SELECT * FROM "Voucher" ORDER BY "createdAt" DESC
    `;
    return rows.map((row) => this.mapVoucher(row));
  }

  async getVoucher(voucherId: string) {
    const rows = await this.prisma.$queryRaw<VoucherRow[]>`
      SELECT * FROM "Voucher" WHERE "id" = ${voucherId}::uuid LIMIT 1
    `;
    const row = rows[0];
    if (!row) {
      throw new NotFoundException("Voucher not found");
    }
    return this.mapVoucher(row);
  }

  async createVoucher(dto: CreateVoucherDto, actor: AuthenticatedUser) {
    const valueCredits = this.positiveDecimal(dto.valueCredits, "valueCredits");
    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException("Voucher expiry must be in the future");
    }
    const code = generateVoucherCode();
    const codeHash = hashVoucherCode(code);
    const id = randomUUID();

    const rows = await this.prisma.$queryRaw<VoucherRow[]>`
      INSERT INTO "Voucher" (
        "id", "codeHash", "valueCredits", "expiresAt", "createdBy"
      ) VALUES (
        ${id}::uuid, ${codeHash}, ${valueCredits}, ${expiresAt}, ${actor.id}::uuid
      ) RETURNING *
    `;
    const voucher = rows[0];
    if (!voucher) {
      throw new ConflictException("Voucher creation failed");
    }
    await this.prisma.auditLogEntry.create({
      data: {
        tenantName: "Platform",
        actor: actor.id,
        actorName: actor.displayName,
        action: "billing.voucher.create",
        resourceType: "Voucher",
        resourceId: id,
        result: "Success",
        correlationId: randomUUID(),
        changes: {
          valueCredits: valueCredits.toString(),
          expiresAt: expiresAt?.toISOString() ?? null,
        },
      },
    });

    return { ...this.mapVoucher(voucher), code };
  }

  async disableVoucher(voucherId: string, actor: AuthenticatedUser) {
    const result = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<VoucherRow[]>`
        SELECT * FROM "Voucher" WHERE "id" = ${voucherId}::uuid FOR UPDATE
      `;
      const voucher = rows[0];
      if (!voucher) {
        throw new NotFoundException("Voucher not found");
      }
      if (voucher.status === "Redeemed") {
        throw new ConflictException("VoucherAlreadyRedeemed");
      }
      if (voucher.status === "Disabled") {
        return voucher;
      }
      const updated = await tx.$queryRaw<VoucherRow[]>`
        UPDATE "Voucher"
        SET "status" = 'Disabled', "disabledAt" = CURRENT_TIMESTAMP,
            "disabledByUserId" = ${actor.id}::uuid
        WHERE "id" = ${voucherId}::uuid
        RETURNING *
      `;
      await tx.auditLogEntry.create({
        data: {
          tenantName: "Platform",
          actor: actor.id,
          actorName: actor.displayName,
          action: "billing.voucher.disable",
          resourceType: "Voucher",
          resourceId: voucherId,
          result: "Success",
          correlationId: randomUUID(),
        },
      });
      return updated[0] ?? voucher;
    });

    return this.mapVoucher(result);
  }

  async redeemVoucher(tenantId: string, code: string, actor: AuthenticatedUser) {
    const tenant = await this.findTenantOrThrow(tenantId);
    const codeHash = hashVoucherCode(code);

    return this.prisma.$transaction(async (tx) => {
      const voucherRows = await tx.$queryRaw<VoucherRow[]>`
        SELECT * FROM "Voucher" WHERE "codeHash" = ${codeHash} FOR UPDATE
      `;
      const voucher = voucherRows[0];
      if (!voucher) {
        throw new NotFoundException("VoucherNotFound");
      }
      const now = new Date();
      if (!isVoucherRedeemable(voucher, now)) {
        const message =
          voucher.status === "Redeemed"
            ? "VoucherAlreadyRedeemed"
            : voucher.status === "Disabled"
              ? "VoucherDisabled"
              : "VoucherExpired";
        throw new ConflictException(message);
      }

      const account = await this.lockAccount(tx, tenantId);
      const mutation = await this.applyBalanceMutation(tx, {
        account,
        tenantName: tenant.name,
        type: "VoucherRedeem",
        amount: voucher.valueCredits,
        reference: `voucher:${voucher.id}`,
        actor,
        auditAction: "billing.voucher.redeem",
        auditResourceType: "Voucher",
        auditResourceId: voucher.id,
      });
      await tx.$executeRaw`
        UPDATE "Voucher"
        SET "status" = 'Redeemed', "redeemedAt" = ${now},
            "redeemedByUserId" = ${actor.id}::uuid,
            "redeemedBillingAccountId" = ${account.id}::uuid
        WHERE "id" = ${voucher.id}::uuid
      `;

      return mutation;
    });
  }

  async topUp(tenantId: string, amountCredits: string, reference: string | undefined, actor: AuthenticatedUser) {
    return this.mutateBalance(tenantId, "TopUp", new Prisma.Decimal(amountCredits), actor, {
      reference,
      auditAction: "billing.topup",
    });
  }

  payment(dto: PlatformBalanceMutationDto, actor: AuthenticatedUser) {
    return this.mutateBalance(dto.tenantId, "Payment", new Prisma.Decimal(dto.amountCredits), actor, {
      reference: dto.reference,
      reason: dto.reason,
      sourceTransactionId: dto.sourceTransactionId,
      auditAction: "billing.payment",
    });
  }

  refund(dto: PlatformBalanceMutationDto, actor: AuthenticatedUser) {
    return this.mutateBalance(dto.tenantId, "Refund", new Prisma.Decimal(dto.amountCredits), actor, {
      reference: dto.reference,
      reason: dto.reason,
      sourceTransactionId: dto.sourceTransactionId,
      auditAction: "billing.refund",
    });
  }

  correction(dto: PlatformBalanceMutationDto, actor: AuthenticatedUser) {
    return this.mutateBalance(dto.tenantId, "Correction", new Prisma.Decimal(dto.amountCredits), actor, {
      reference: dto.reference,
      reason: dto.reason,
      sourceTransactionId: dto.sourceTransactionId,
      auditAction: "billing.correction",
    });
  }

  async recordUsageCharge(input: {
    tenantId: string;
    resourceType: "Compute" | "Storage";
    resourceId: string;
    appGroupId?: string;
    periodStart: Date;
    periodEnd: Date;
    usage: Prisma.InputJsonObject;
    theoreticalCost: Prisma.Decimal;
    priceListVersionId: string;
    allowDebt: boolean;
  }) {
    const tenant = await this.findTenantOrThrow(input.tenantId);

    return this.prisma.$transaction(async (tx) => {
      const account = await this.lockAccount(tx, input.tenantId);
      const existing = await tx.usageRecord.findFirst({
        where: {
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
        },
      });
      if (existing) {
        return { duplicate: true, usageRecordId: existing.id };
      }

      const chargedCredits = input.allowDebt
        ? input.theoreticalCost
        : clampComputeCharge(input.theoreticalCost, account.balance);
      const usageRecordId = randomUUID();
      const usage = {
        ...input.usage,
        priceListVersionId: input.priceListVersionId,
        theoreticalCostCredits: input.theoreticalCost.toString(),
        chargedCredits: chargedCredits.toString(),
      } satisfies Prisma.InputJsonObject;

      await tx.$executeRaw`
        INSERT INTO "UsageRecord" (
          "id", "billingAccountId", "tenantId", "resourceType", "resourceId",
          "periodStart", "periodEnd", "usage", "cost", "chargedCredits",
          "priceListVersionId", "appGroupId"
        ) VALUES (
          ${usageRecordId}::uuid, ${account.id}::uuid, ${input.tenantId}::uuid,
          ${input.resourceType}, ${input.resourceId}::uuid, ${input.periodStart},
          ${input.periodEnd}, ${JSON.stringify(usage)}::jsonb, ${input.theoreticalCost},
          ${chargedCredits}, ${input.priceListVersionId}::uuid,
          ${input.appGroupId ?? null}::uuid
        )
      `;

      if (chargedCredits.gt(0)) {
        await this.applyBalanceMutation(tx, {
          account,
          tenantName: tenant.name,
          type: "UsageCharge",
          amount: chargedCredits,
          reference: `usage:${usageRecordId}`,
          actor: { id: "system:billing-worker", displayName: "Billing Worker" },
          auditAction: "billing.usage_charge",
          auditResourceType: input.resourceType,
          auditResourceId: input.resourceId,
          auditChanges: {
            usageRecordId,
            priceListVersionId: input.priceListVersionId,
            theoreticalCostCredits: input.theoreticalCost.toString(),
            chargedCredits: chargedCredits.toString(),
          },
        });
      } else {
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
              chargedCredits: "0",
            },
          },
        });
      }

      return { duplicate: false, usageRecordId, chargedCredits: chargedCredits.toString() };
    });
  }

  private async mutateBalance(
    tenantId: string,
    type: BillingLedgerType,
    amount: Prisma.Decimal,
    actor: AuthenticatedUser,
    options: {
      reference?: string;
      reason?: string;
      sourceTransactionId?: string;
      auditAction: string;
    },
  ) {
    if (amount.isZero()) {
      throw new BadRequestException("Billing amount cannot be zero");
    }
    if (type !== "Correction" && amount.lt(0)) {
      amount = amount.abs();
    }
    const tenant = await this.findTenantOrThrow(tenantId);

    return this.prisma.$transaction(async (tx) => {
      const account = await this.lockAccount(tx, tenantId);
      if (options.sourceTransactionId) {
        const source = await tx.billingTransaction.findFirst({
          where: {
            id: options.sourceTransactionId,
            billingAccountId: account.id,
          },
          select: { id: true },
        });
        if (!source) {
          throw new NotFoundException("Source billing transaction not found");
        }
      }

      return this.applyBalanceMutation(tx, {
        account,
        tenantName: tenant.name,
        type,
        amount,
        reference: options.reference,
        reason: options.reason,
        sourceTransactionId: options.sourceTransactionId,
        actor,
        auditAction: options.auditAction,
        auditResourceType: "BillingAccount",
        auditResourceId: account.id,
      });
    });
  }

  private async applyBalanceMutation(
    tx: Prisma.TransactionClient,
    input: {
      account: LockedBillingAccount;
      tenantName: string;
      type: BillingLedgerType;
      amount: Prisma.Decimal;
      reference?: string;
      reason?: string;
      sourceTransactionId?: string;
      actor: ActorSnapshot;
      auditAction: string;
      auditResourceType: string;
      auditResourceId: string;
      auditChanges?: Prisma.InputJsonObject;
    },
  ) {
    const ledgerAmount = normalizeLedgerAmount(input.type, input.amount);
    const balanceBefore = input.account.balance;
    const balanceAfter = balanceBefore.plus(ledgerAmount);
    const billing = await tx.billingAccount.update({
      where: { id: input.account.id },
      data: { balance: balanceAfter },
    });
    const transaction = await tx.billingTransaction.create({
      data: {
        billingAccountId: input.account.id,
        type: input.type,
        amount: ledgerAmount,
        balanceBefore,
        balanceAfter,
        status: "Succeeded",
        reference: input.reference,
      },
    });
    if (input.reason || input.sourceTransactionId) {
      await tx.$executeRaw`
        UPDATE "BillingTransaction"
        SET "reason" = ${input.reason ?? null},
            "sourceTransactionId" = ${input.sourceTransactionId ?? null}::uuid
        WHERE "id" = ${transaction.id}::uuid
      `;
    }

    const accountStateBefore = billingState(
      balanceBefore,
      input.account.informationThreshold,
    );
    const accountStateAfter = billingState(
      balanceAfter,
      input.account.informationThreshold,
    );
    await tx.auditLogEntry.create({
      data: {
        tenantId: input.account.tenantId,
        tenantName: input.tenantName,
        actor: input.actor.id,
        actorName: input.actor.displayName,
        action: input.auditAction,
        resourceType: input.auditResourceType,
        resourceId: input.auditResourceId,
        result: "Success",
        correlationId: randomUUID(),
        changes: {
          transactionId: transaction.id,
          type: input.type,
          amountCredits: ledgerAmount.toString(),
          balanceBeforeCredits: balanceBefore.toString(),
          balanceAfterCredits: balanceAfter.toString(),
          reference: input.reference ?? null,
          reason: input.reason ?? null,
          sourceTransactionId: input.sourceTransactionId ?? null,
          ...(input.auditChanges ?? {}),
        },
      },
    });

    if (accountStateBefore.state !== accountStateAfter.state) {
      await tx.auditLogEntry.create({
        data: {
          tenantId: input.account.tenantId,
          tenantName: input.tenantName,
          actor: input.actor.id,
          actorName: input.actor.displayName,
          action:
            accountStateAfter.state === "BillingSuspended"
              ? "billing.suspend"
              : "billing.reactivate",
          resourceType: "BillingAccount",
          resourceId: input.account.id,
          result: "Success",
          correlationId: randomUUID(),
          changes: {
            balanceBeforeCredits: balanceBefore.toString(),
            balanceAfterCredits: balanceAfter.toString(),
          },
        },
      });
    }

    return {
      billing: this.mapAccount(billing),
      transaction: this.mapTransaction(transaction),
    };
  }

  private async lockAccount(tx: Prisma.TransactionClient, tenantId: string) {
    const rows = await tx.$queryRaw<LockedBillingAccount[]>`
      SELECT "id", "tenantId", "balance", "currency", "informationThreshold"
      FROM "BillingAccount"
      WHERE "tenantId" = ${tenantId}::uuid
      FOR UPDATE
    `;
    const account = rows[0];
    if (!account) {
      throw new NotFoundException("Billing account not found");
    }
    return account;
  }

  private async findAccountOrThrow(tenantId: string) {
    const account = await this.prisma.billingAccount.findUnique({
      where: { tenantId },
    });
    if (!account) {
      throw new NotFoundException("Billing account not found");
    }
    return account;
  }

  private async findTenantOrThrow(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true },
    });
    if (!tenant) {
      throw new NotFoundException("Tenant not found");
    }
    return tenant;
  }

  private mapAccount(account: {
    id: string;
    tenantId: string;
    balance: Prisma.Decimal;
    currency: string;
    informationThreshold: Prisma.Decimal;
  }) {
    const derived = billingState(account.balance, account.informationThreshold);
    return {
      id: account.id,
      tenantId: account.tenantId,
      balanceCredits: account.balance.toString(),
      balancePln: creditsToPln(account.balance).toString(),
      balance: account.balance.toString(),
      currency: account.currency,
      informationThresholdCredits: account.informationThreshold.toString(),
      informationThresholdPln: creditsToPln(account.informationThreshold).toString(),
      state: derived.state === "BillingSuspended" ? "Suspended" : "Active",
      billingState: derived.state,
      lowBalance: derived.lowBalance,
    };
  }

  private mapTransaction(transaction: {
    id: string;
    billingAccountId: string;
    type: string;
    amount: Prisma.Decimal;
    balanceBefore: Prisma.Decimal;
    balanceAfter: Prisma.Decimal;
    status: string;
    reference: string | null;
    createdAt: Date;
  }) {
    return {
      id: transaction.id,
      billingAccountId: transaction.billingAccountId,
      type: transaction.type,
      amountCredits: transaction.amount.toString(),
      amountPln: creditsToPln(transaction.amount).toString(),
      balanceBeforeCredits: transaction.balanceBefore.toString(),
      balanceBeforePln: creditsToPln(transaction.balanceBefore).toString(),
      balanceAfterCredits: transaction.balanceAfter.toString(),
      balanceAfterPln: creditsToPln(transaction.balanceAfter).toString(),
      status: transaction.status,
      reference: transaction.reference,
      createdAt: transaction.createdAt,
    };
  }

  private mapUsageRecord(record: {
    id: string;
    billingAccountId: string;
    tenantId: string;
    resourceType: string;
    resourceId: string;
    periodStart: Date;
    periodEnd: Date;
    usage: Prisma.JsonValue;
    cost: Prisma.Decimal;
  }) {
    return {
      id: record.id,
      billingAccountId: record.billingAccountId,
      tenantId: record.tenantId,
      resourceType: record.resourceType,
      resourceId: record.resourceId,
      periodStart: record.periodStart,
      periodEnd: record.periodEnd,
      usage: record.usage,
      costCredits: record.cost.toString(),
      costPln: creditsToPln(record.cost).toString(),
    };
  }

  private mapPriceList(row: PriceListRow) {
    return {
      id: row.id,
      version: row.version,
      effectiveFrom: row.effectiveFrom,
      cpuCreditsPerVcpuHour: row.cpuCreditsPerVcpuHour.toString(),
      memoryCreditsPerGbHour: row.memoryCreditsPerGbHour.toString(),
      storageCreditsPerGbHour: row.storageCreditsPerGbHour.toString(),
      gpuCreditsPerGpuHour: row.gpuCreditsPerGpuHour.toString(),
      createdBy: row.createdBy,
      createdAt: row.createdAt,
    };
  }

  private mapVoucher(row: VoucherRow) {
    const expired =
      row.status === "Active" &&
      row.expiresAt !== null &&
      row.expiresAt.getTime() <= Date.now();
    return {
      id: row.id,
      valueCredits: row.valueCredits.toString(),
      valuePln: creditsToPln(row.valueCredits).toString(),
      status: expired ? "Expired" : row.status,
      expiresAt: row.expiresAt,
      redeemedAt: row.redeemedAt,
      redeemedByUserId: row.redeemedByUserId,
      redeemedBillingAccountId: row.redeemedBillingAccountId,
      disabledAt: row.disabledAt,
      disabledByUserId: row.disabledByUserId,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
    };
  }

  private dateFilter(from?: string, to?: string) {
    if (!from && !to) {
      return undefined;
    }
    return {
      gte: from ? new Date(from) : undefined,
      lte: to ? new Date(to) : undefined,
    };
  }

  private positiveDecimal(value: string, field: string) {
    const amount = new Prisma.Decimal(value);
    if (amount.lte(0)) {
      throw new BadRequestException(`${field} must be greater than zero`);
    }
    return amount;
  }

  private nonNegativeDecimal(value: string, field: string) {
    const amount = new Prisma.Decimal(value);
    if (amount.lt(0)) {
      throw new BadRequestException(`${field} cannot be negative`);
    }
    return amount;
  }
}
