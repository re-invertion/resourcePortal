import { Injectable } from "@nestjs/common";
import { UserStatus } from "@prisma/client";
import type { AuthenticatedUser } from "../../auth/types";
import type { CreateVolumeDto } from "../../volumes/dto/create-volume.dto";
import type { ResizeVolumeDto } from "../../volumes/dto/resize-volume.dto";
import { VolumesService } from "../../volumes/volumes.service";
import type { OperationExecutor } from "../operation-executor";
import type {
  OperationRecord,
  OperationType,
} from "../operation.types";

@Injectable()
export class VolumeOperationExecutor implements OperationExecutor {
  readonly types = [
    "VOLUME_CREATE",
    "VOLUME_RESIZE",
    "VOLUME_DELETE",
  ] as const satisfies readonly OperationType[];

  constructor(private readonly volumes: VolumesService) {}

  async execute(operation: OperationRecord) {
    const tenantId = this.requireTenantId(operation);
    const actor = this.actor(operation);

    switch (operation.type) {
      case "VOLUME_CREATE": {
        const dto = this.dto<CreateVolumeDto>(operation);
        const volume = await this.volumes.createVolume(tenantId, dto, actor);
        return { resourceId: volume.id, result: volume };
      }
      case "VOLUME_RESIZE": {
        const resourceId = this.requireResourceId(operation);
        const dto = this.dto<ResizeVolumeDto>(operation);
        const volume = await this.volumes.resizeVolume(
          tenantId,
          resourceId,
          dto,
          actor,
        );
        return { resourceId, result: volume };
      }
      case "VOLUME_DELETE": {
        const resourceId = this.requireResourceId(operation);
        const result = await this.volumes.deleteVolume(
          tenantId,
          resourceId,
          actor,
        );
        return { resourceId, result };
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

  private dto<T>(operation: OperationRecord) {
    if (
      typeof operation.input !== "object" ||
      operation.input === null ||
      !("dto" in operation.input)
    ) {
      throw new Error("InvalidOperationInput");
    }
    return operation.input.dto as T;
  }

  private requireTenantId(operation: OperationRecord) {
    if (!operation.tenantId) {
      throw new Error("OperationTenantRequired");
    }
    return operation.tenantId;
  }

  private requireResourceId(operation: OperationRecord) {
    if (!operation.resourceId) {
      throw new Error("OperationResourceRequired");
    }
    return operation.resourceId;
  }
}
