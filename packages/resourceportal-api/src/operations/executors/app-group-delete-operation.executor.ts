import { Injectable } from "@nestjs/common";
import { StackRuntimeService } from "../../internal/stack-runtime.service";
import { PrismaService } from "../../prisma/prisma.service";
import type { OperationExecutor } from "../operation-executor";
import type { OperationRecord, OperationType } from "../operation.types";

@Injectable()
export class AppGroupDeleteOperationExecutor implements OperationExecutor {
  readonly types = ["APP_GROUP_DELETE"] as const satisfies readonly OperationType[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly runtime: StackRuntimeService,
  ) {}

  async execute(operation: OperationRecord) {
    const tenantId = operation.tenantId;
    const appGroupId = operation.resourceId;
    if (!tenantId || !appGroupId) {
      throw this.error(
        "OperationInputInvalid",
        "App Group deletion requires tenantId and resourceId",
        false,
      );
    }

    const appGroup = await this.prisma.appGroup.findFirst({
      where: { id: appGroupId, tenantId },
      select: { id: true, status: true, name: true },
    });

    if (!appGroup) {
      return {
        resourceId: appGroupId,
        result: { deleted: true, alreadyApplied: true },
      };
    }

    if (appGroup.status !== "Deleting") {
      throw this.error(
        "AppGroupNotDeleting",
        `App Group ${appGroup.name} is not marked for deletion`,
        false,
      );
    }

    const cleanup = await this.runtime.removeAppGroupRuntime(appGroupId);
    if (!cleanup.success) {
      throw this.error(
        "AppGroupRuntimeCleanupFailed",
        cleanup.error ?? "App Group runtime cleanup failed",
        true,
      );
    }

    const deleted = await this.prisma.appGroup.deleteMany({
      where: { id: appGroupId, tenantId, status: "Deleting" },
    });
    if (deleted.count === 0) {
      const remaining = await this.prisma.appGroup.findFirst({
        where: { id: appGroupId, tenantId },
        select: { status: true },
      });
      if (remaining) {
        throw this.error(
          "AppGroupDeletionStateChanged",
          "App Group deletion state changed during cleanup",
          true,
        );
      }
    }

    return {
      resourceId: appGroupId,
      result: {
        deleted: true,
        alreadyApplied: false,
        runtimeChanged: cleanup.changed,
      },
    };
  }

  private error(code: string, message: string, retryable: boolean) {
    return Object.assign(new Error(message), { code, retryable });
  }
}
