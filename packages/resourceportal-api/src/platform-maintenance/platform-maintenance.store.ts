import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { PLATFORM_MAINTENANCE_STATE_ID } from "./platform-maintenance.constants";

export type PlatformMaintenanceStateRow = {
  id: string;
  enabled: boolean;
  reason: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class PlatformMaintenanceStore {
  constructor(private readonly prisma: PrismaService) {}

  async getState() {
    const rows = await this.prisma.$queryRaw<PlatformMaintenanceStateRow[]>`
      INSERT INTO "PlatformMaintenanceState" (
        "id",
        "enabled",
        "reason",
        "updatedBy",
        "createdAt",
        "updatedAt"
      )
      VALUES (
        ${PLATFORM_MAINTENANCE_STATE_ID}::uuid,
        false,
        NULL,
        NULL,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT ("id") DO UPDATE
      SET "id" = EXCLUDED."id"
      RETURNING *
    `;

    return rows[0];
  }

  async setState(input: {
    enabled: boolean;
    reason: string | null;
    updatedBy: string;
  }) {
    const rows = await this.prisma.$queryRaw<PlatformMaintenanceStateRow[]>`
      INSERT INTO "PlatformMaintenanceState" (
        "id",
        "enabled",
        "reason",
        "updatedBy",
        "createdAt",
        "updatedAt"
      )
      VALUES (
        ${PLATFORM_MAINTENANCE_STATE_ID}::uuid,
        ${input.enabled},
        ${input.reason},
        ${input.updatedBy}::uuid,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT ("id") DO UPDATE
      SET
        "enabled" = EXCLUDED."enabled",
        "reason" = EXCLUDED."reason",
        "updatedBy" = EXCLUDED."updatedBy",
        "updatedAt" = CURRENT_TIMESTAMP
      RETURNING *
    `;

    return rows[0];
  }
}
