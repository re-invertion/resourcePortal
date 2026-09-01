import { Injectable } from "@nestjs/common";
import { AuthenticatedUser } from "../auth/types";
import { PrismaService } from "../prisma/prisma.service";
import { PLATFORM_MAINTENANCE_STATE_ID } from "./platform-maintenance.constants";

@Injectable()
export class PlatformMaintenanceAuditService {
  constructor(private readonly prisma: PrismaService) {}

  async recordChanged(input: {
    enabled: boolean;
    reason: string | null;
    actor: AuthenticatedUser;
  }) {
    await this.prisma.auditLogEntry.create({
      data: {
        tenantId: null,
        tenantName: "platform",
        actor: input.actor.id,
        actorName: input.actor.displayName,
        action: input.enabled
          ? "platform.maintenance.enabled"
          : "platform.maintenance.disabled",
        resourceType: "PlatformMaintenanceState",
        resourceId: PLATFORM_MAINTENANCE_STATE_ID,
        resourceName: "platform-maintenance",
        result: "Success",
        changes: {
          enabled: input.enabled,
          reason: input.reason,
        },
      },
    });
  }
}
