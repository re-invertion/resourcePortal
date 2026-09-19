import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { mapAuditLogEntry } from "./audit.view";
import {
  AuditLogFiltersDto,
  ExportAuditLogDto,
  ListAuditLogDto,
} from "./dto/list-audit-log.dto";

const BILLING_USAGE_ACTION = "billing.usage_charge";

const CSV_COLUMNS = [
  "tenantId",
  "tenantName",
  "timestamp",
  "actor",
  "actorName",
  "action",
  "resourceType",
  "resourceId",
  "resourceName",
  "result",
  "errorCode",
  "errorMessage",
  "requestId",
  "correlationId",
  "ipAddress",
  "userAgent",
  "changes",
] as const;

type AuditListItem = ReturnType<typeof mapAuditLogEntry> & {
  grouped?: boolean;
  groupedCount?: number;
  groupedFrom?: Date;
  groupedTo?: Date;
};

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async listAuditLog(tenantId: string, query: ListAuditLogDto) {
    const tenant = await this.assertTenantExists(tenantId);
    const where = this.buildWhere(tenantId, query);
    const take = query.limit ?? 50;

    const billingSummary =
      !query.cursor && (!query.action || query.action === BILLING_USAGE_ACTION)
        ? await this.buildBillingUsageSummary(tenantId, tenant.name, where)
        : null;

    const rawCapacity = Math.max(0, take - (billingSummary ? 1 : 0));
    const shouldListRawEntries = query.action !== BILLING_USAGE_ACTION && rawCapacity > 0;
    const rawWhere: Prisma.AuditLogEntryWhereInput = query.action
      ? where
      : { ...where, action: { not: BILLING_USAGE_ACTION } };

    const entries = shouldListRawEntries
      ? await this.prisma.auditLogEntry.findMany({
          where: rawWhere,
          orderBy: [{ timestamp: "desc" }, { id: "desc" }],
          take: rawCapacity + 1,
          ...(query.cursor
            ? {
                cursor: { id: query.cursor },
                skip: 1,
              }
            : {}),
        })
      : [];

    const hasNextPage = entries.length > rawCapacity;
    const rawItems = entries.slice(0, rawCapacity);
    const mappedItems: AuditListItem[] = rawItems.map(mapAuditLogEntry);
    const items = billingSummary
      ? [...mappedItems, billingSummary].sort((left, right) => {
          const time = right.timestamp.getTime() - left.timestamp.getTime();
          return time || right.id.localeCompare(left.id);
        })
      : mappedItems;

    return {
      items,
      nextCursor: hasNextPage ? rawItems.at(-1)?.id ?? null : null,
    };
  }

  async exportAuditLog(tenantId: string, query: ExportAuditLogDto) {
    await this.assertTenantExists(tenantId);
    const entries = await this.prisma.auditLogEntry.findMany({
      where: this.buildWhere(tenantId, query),
      orderBy: [{ timestamp: "desc" }, { id: "desc" }],
    });
    const items = entries.map(mapAuditLogEntry);

    if (query.format === "csv") {
      return {
        contentType: "text/csv; charset=utf-8",
        fileName: `audit-log-${tenantId}.csv`,
        body: this.toCsv(items),
      };
    }

    return {
      contentType: "application/json; charset=utf-8",
      fileName: `audit-log-${tenantId}.json`,
      body: JSON.stringify(items),
    };
  }

  private async buildBillingUsageSummary(
    tenantId: string,
    tenantName: string,
    baseWhere: Prisma.AuditLogEntryWhereInput,
  ): Promise<AuditListItem | null> {
    const where: Prisma.AuditLogEntryWhereInput = {
      ...baseWhere,
      action: BILLING_USAGE_ACTION,
    };
    const aggregate = await this.prisma.auditLogEntry.aggregate({
      where,
      _count: { _all: true },
      _min: { timestamp: true },
      _max: { timestamp: true },
    });
    const count = aggregate._count._all;
    const from = aggregate._min.timestamp;
    const to = aggregate._max.timestamp;
    if (!count || !from || !to) {
      return null;
    }

    return {
      id: `billing-usage-summary:${tenantId}:${to.toISOString()}`,
      tenantId,
      tenantName,
      timestamp: to,
      actor: "system:billing-worker",
      actorName: "Billing Worker",
      action: BILLING_USAGE_ACTION,
      resourceType: "BillingUsage",
      resourceId: null,
      resourceName: `${count} usage charge${count === 1 ? "" : "s"}`,
      result: "Success",
      errorCode: null,
      errorMessage: null,
      requestId: null,
      correlationId: null,
      ipAddress: null,
      userAgent: null,
      changes: {
        grouped: true,
        groupedCount: count,
        groupedFrom: from.toISOString(),
        groupedTo: to.toISOString(),
      },
      grouped: true,
      groupedCount: count,
      groupedFrom: from,
      groupedTo: to,
    };
  }

  private async assertTenantExists(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true },
    });

    if (!tenant) {
      throw new NotFoundException("Tenant not found");
    }

    return tenant;
  }

  private buildWhere(
    tenantId: string,
    query: AuditLogFiltersDto,
  ): Prisma.AuditLogEntryWhereInput {
    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;
    if (from && to && from > to) {
      throw new BadRequestException("Audit log 'from' must not be after 'to'");
    }

    return {
      tenantId,
      action: query.action,
      actor: query.actor,
      resourceType: query.resourceType,
      resourceId: query.resourceId,
      result: query.result,
      requestId: query.requestId,
      correlationId: query.correlationId,
      timestamp:
        from || to
          ? {
              gte: from,
              lte: to,
            }
          : undefined,
    };
  }

  private toCsv(items: ReturnType<typeof mapAuditLogEntry>[]) {
    const header = CSV_COLUMNS.join(",");
    const rows = items.map((item) =>
      CSV_COLUMNS.map((column) => this.csvCell(item[column])).join(","),
    );

    return [header, ...rows].join("\n");
  }

  private csvCell(value: unknown) {
    if (value === null || value === undefined) {
      return "";
    }

    let serialized: string;
    if (value instanceof Date) {
      serialized = value.toISOString();
    } else if (typeof value === "object") {
      serialized = JSON.stringify(value);
    } else if (typeof value === "string") {
      serialized = value;
    } else if (
      typeof value === "number" ||
      typeof value === "boolean" ||
      typeof value === "bigint"
    ) {
      serialized = value.toString();
    } else {
      serialized = "";
    }

    return /[",\r\n]/.test(serialized)
      ? `"${serialized.replaceAll('"', '""')}"`
      : serialized;
  }
}