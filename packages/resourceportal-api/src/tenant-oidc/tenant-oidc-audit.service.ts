import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import type { AuthenticatedUser } from "../auth/types";

@Injectable()
export class TenantOidcAuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(
    tenantId: string,
    actor: AuthenticatedUser,
    action: string,
    outcome: "Success" | "Failed",
  ) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true },
    });
    await this.prisma.auditLogEntry.create({
      data: {
        tenantId,
        tenantName: tenant?.name ?? "unknown",
        actor: actor.id,
        actorName: actor.displayName,
        action: `tenant_oidc.${action}`,
        resourceType: "TenantOidcProvider",
        resourceId: tenantId,
        resourceName: tenant?.name ?? "unknown",
        result: outcome,
        correlationId: randomUUID(),
        changes: { outcome },
      },
    });
  }
}
