import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { mapAuditLogEntry } from "./audit.view";
import { ListAuditLogDto } from "./dto/list-audit-log.dto";

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async listAuditLog(tenantId: string, query: ListAuditLogDto) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });

    if (!tenant) {
      throw new NotFoundException("Tenant not found");
    }

    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;
    if (from && to && from > to) {
      throw new BadRequestException("Audit log 'from' must not be after 'to'");
    }

    const where: Prisma.AuditLogEntryWhereInput = {
      tenantId,
      action: query.action,
      actor: query.actor,
      resourceType: query.resourceType,
      result: query.result,
      timestamp:
        from || to
          ? {
              gte: from,
              lte: to,
            }
          : undefined,
    };
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
}
