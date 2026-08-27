import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { mapAuditLogEntry } from "./audit.view";

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async listAuditLog(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });

    if (!tenant) {
      throw new NotFoundException("Tenant not found");
    }

    const entries = await this.prisma.auditLogEntry.findMany({
      where: { tenantId },
      orderBy: { timestamp: "desc" },
      take: 200,
    });

    return entries.map(mapAuditLogEntry);
  }
}
