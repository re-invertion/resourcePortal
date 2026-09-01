import { Injectable } from "@nestjs/common";
import { AuthenticatedUser } from "../auth/types";
import { PlatformMaintenanceAuditService } from "./platform-maintenance-audit.service";
import { PlatformMaintenanceStore } from "./platform-maintenance.store";

@Injectable()
export class PlatformMaintenanceService {
  constructor(
    private readonly store: PlatformMaintenanceStore,
    private readonly audit: PlatformMaintenanceAuditService,
  ) {}

  async getState() {
    return this.mapState(await this.store.getState());
  }

  async setState(
    enabled: boolean,
    reason: string | null | undefined,
    actor: AuthenticatedUser,
  ) {
    const normalizedReason = enabled ? normalizeReason(reason) : null;
    const state = await this.store.setState({
      enabled,
      reason: normalizedReason,
      updatedBy: actor.id,
    });

    await this.audit.recordChanged({
      enabled,
      reason: normalizedReason,
      actor,
    });

    return this.mapState(state);
  }

  private mapState(state: {
    enabled: boolean;
    reason: string | null;
    updatedBy: string | null;
    updatedAt: Date;
  }) {
    return {
      enabled: state.enabled,
      reason: state.reason,
      updatedBy: state.updatedBy,
      updatedAt: state.updatedAt,
    };
  }
}

function normalizeReason(reason: string | null | undefined) {
  const normalized = reason?.trim();
  return normalized ? normalized : null;
}
