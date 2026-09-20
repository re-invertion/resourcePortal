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

  getState(): Promise<PlatformMaintenanceStateRow> {
    return this.prisma.platformMaintenanceState.upsert({
      where: { id: PLATFORM_MAINTENANCE_STATE_ID },
      create: {
        id: PLATFORM_MAINTENANCE_STATE_ID,
        enabled: false,
        reason: null,
        updatedBy: null,
      },
      update: {},
    });
  }

  setState(input: {
    enabled: boolean;
    reason: string | null;
    updatedBy: string;
  }): Promise<PlatformMaintenanceStateRow> {
    return this.prisma.platformMaintenanceState.upsert({
      where: { id: PLATFORM_MAINTENANCE_STATE_ID },
      create: {
        id: PLATFORM_MAINTENANCE_STATE_ID,
        enabled: input.enabled,
        reason: input.reason,
        updatedBy: input.updatedBy,
      },
      update: {
        enabled: input.enabled,
        reason: input.reason,
        updatedBy: input.updatedBy,
      },
    });
  }
}
