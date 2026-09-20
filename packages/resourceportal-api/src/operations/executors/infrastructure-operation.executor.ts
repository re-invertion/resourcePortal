import { Injectable } from "@nestjs/common";
import { UserStatus } from "@prisma/client";
import type { AuthenticatedUser } from "../../auth/types";
import { SwarmInfrastructureService } from "../../platform-infrastructure/swarm-infrastructure.service";
import { StorageBackendsService } from "../../storage-backends/storage-backends.service";
import type { OperationExecutor } from "../operation-executor";
import type { OperationRecord, OperationType } from "../operation.types";

@Injectable()
export class InfrastructureOperationExecutor implements OperationExecutor {
  readonly types = [
    "SWARM_RECONCILE",
    "SWARM_NODE_MAINTENANCE",
    "STORAGE_BACKEND_VALIDATE",
  ] as const satisfies readonly OperationType[];

  constructor(
    private readonly swarm: SwarmInfrastructureService,
    private readonly storage: StorageBackendsService,
  ) {}

  async execute(operation: OperationRecord) {
    switch (operation.type) {
      case "SWARM_RECONCILE":
        return { result: await this.swarm.reconcile() };
      case "SWARM_NODE_MAINTENANCE": {
        const resourceId = this.requireResourceId(operation);
        const enabled = this.booleanInput(operation, "enabled");
        return {
          resourceId,
          result: await this.swarm.setMaintenance(resourceId, enabled, this.actor(operation)),
        };
      }
      case "STORAGE_BACKEND_VALIDATE": {
        const resourceId = this.requireResourceId(operation);
        return { resourceId, result: await this.storage.validateBackend(resourceId) };
      }
      default:
        throw new Error(`UnsupportedOperationType: ${operation.type}`);
    }
  }

  private actor(operation: OperationRecord): AuthenticatedUser {
    return {
      id: operation.createdBy,
      email: operation.createdByEmail,
      displayName: operation.createdByDisplayName,
      status: UserStatus.Active,
    };
  }

  private requireResourceId(operation: OperationRecord) {
    if (!operation.resourceId) throw new Error("OperationResourceRequired");
    return operation.resourceId;
  }

  private booleanInput(operation: OperationRecord, key: string) {
    const input =
      typeof operation.input === "object" && operation.input !== null
        ? (operation.input as Record<string, unknown>)
        : {};
    const value = input[key];
    if (typeof value !== "boolean") throw new Error("InvalidOperationInput");
    return value;
  }
}
