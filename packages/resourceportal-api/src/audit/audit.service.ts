import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { mapAuditLogEntry } from "./audit.view";
import {
  AuditLogFiltersDto,
  ExportAuditLogDto,
  ListAuditLogDto,
} from "./dto/list-audit-log.dto";

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

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async listAuditLog(tenantId: string, query: ListAuditLogDto) {
    await this.assertTenantExists(tenantId);
    const where = this.buildWhere(tenantId, query);
    const take = query.limit ?? 50;
    const entries = await this.prisma.auditLogEntry.findMany({
      where,
      orderBy: [{ timestamp: "desc" }, { id: "desc" }],
      take: take + 1,
      ...(query.cursor
        ? {
            cursor: { id: query.cursor },
            skip: 1,
          }
        : {}),
    });
    const hasNextPage = entries.length > take;
    const items = entries.slice(0, take);

    return {
      items: items.map(mapAuditLogEntry),
      nextCursor: hasNextPage ? items.at(-1)?.id ?? null : null,
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

  private async assertTenantExists(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });

    if (!tenant) {
      throw new NotFoundException("Tenant not found");
    }
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
