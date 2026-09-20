import { Injectable } from "@nestjs/common";
import { DeploymentStatus, RuntimeState } from "@prisma/client";
import { StackRuntimeService } from "../../internal/stack-runtime.service";
import { PrismaService } from "../../prisma/prisma.service";
import type { OperationExecutor } from "../operation-executor";
import type { OperationRecord, OperationType } from "../operation.types";

type RuntimeSnapshot = {
  singleApps?: Array<{ id?: unknown; name?: unknown }>;
};

type ScaleTarget = {
  stackName: string;
  serviceName: string;
  singleAppId: string;
  replicas: number;
};

@Injectable()
export class RuntimeOperationExecutor implements OperationExecutor {
  readonly types = [
    "APP_GROUP_START",
    "APP_GROUP_STOP",
    "APP_GROUP_RESTART",
    "SINGLE_APP_START",
    "SINGLE_APP_STOP",
    "SINGLE_APP_RESTART",
  ] as const satisfies readonly OperationType[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly runtime: StackRuntimeService,
  ) {}

  async execute(operation: OperationRecord) {
    if (operation.type.startsWith("APP_GROUP_")) {
      return this.executeAppGroup(operation);
    }
    return this.executeSingleApp(operation);
  }

  private async executeAppGroup(operation: OperationRecord) {
    const appGroupId = this.requireResourceId(operation);
    const appGroup = await this.prisma.appGroup.findUnique({
      where: { id: appGroupId },
      include: { singleApps: { orderBy: { createdAt: "asc" } } },
    });
    if (!appGroup) throw this.error("AppGroupMissing", "App Group not found", false);

    const names = await this.deployedServiceNames(appGroup.id, appGroup.currentDeploymentVersion);
    const stackName = this.stackName(appGroup.id);

    if (operation.type === "APP_GROUP_RESTART") {
      const targets = appGroup.singleApps.flatMap((singleApp) => {
        const deployedName = names.get(singleApp.id);
        if (
          !deployedName ||
          appGroup.runtimeState !== RuntimeState.Running ||
          singleApp.pendingDeletion ||
          singleApp.runtimeState !== RuntimeState.Running ||
          singleApp.desiredReplicas <= 0
        ) {
          return [];
        }
        return [{ stackName, serviceName: this.serviceName(deployedName) }];
      });
      if (targets.length === 0) {
        return { resourceId: appGroup.id, result: { restartedServices: 0 } };
      }
      const results = await this.runtime.restartServices(targets);
      this.assertRuntimeResults(results);
      return { resourceId: appGroup.id, result: { restartedServices: targets.length } };
    }

    const targets: ScaleTarget[] = appGroup.singleApps.flatMap((singleApp) => {
      const deployedName = names.get(singleApp.id);
      if (!deployedName) return [];
      const replicas =
        appGroup.runtimeState === RuntimeState.Stopped ||
        singleApp.runtimeState === RuntimeState.Stopped ||
        singleApp.pendingDeletion
          ? 0
          : singleApp.desiredReplicas;
      return [
        {
          stackName,
          serviceName: this.serviceName(deployedName),
          singleAppId: singleApp.id,
          replicas,
        },
      ];
    });
    await this.applyScaleTargets(targets);
    return {
      resourceId: appGroup.id,
      result: { scaledServices: targets.length, runtimeState: appGroup.runtimeState },
    };
  }

  private async executeSingleApp(operation: OperationRecord) {
    const singleAppId = this.requireResourceId(operation);
    const input = this.input(operation);
    const appGroupId = typeof input.appGroupId === "string" ? input.appGroupId : null;
    if (!appGroupId) {
      throw this.error("OperationInputInvalid", "SingleApp runtime operation requires appGroupId", false);
    }
    const appGroup = await this.prisma.appGroup.findUnique({
      where: { id: appGroupId },
      include: { singleApps: { orderBy: { createdAt: "asc" } } },
    });
    if (!appGroup) throw this.error("AppGroupMissing", "App Group not found", false);
    const singleApp = appGroup.singleApps.find((item) => item.id === singleAppId);
    if (!singleApp) throw this.error("SingleAppMissing", "SingleApp not found", false);

    const names = await this.deployedServiceNames(appGroup.id, appGroup.currentDeploymentVersion);
    const deployedName = names.get(singleApp.id);
    if (!deployedName) {
      return { resourceId: singleApp.id, result: { runtimeApplied: false } };
    }
    const target = {
      stackName: this.stackName(appGroup.id),
      serviceName: this.serviceName(deployedName),
    };

    if (operation.type === "SINGLE_APP_RESTART") {
      if (
        appGroup.runtimeState !== RuntimeState.Running ||
        singleApp.runtimeState !== RuntimeState.Running ||
        singleApp.pendingDeletion ||
        singleApp.desiredReplicas <= 0
      ) {
        return { resourceId: singleApp.id, result: { restartedServices: 0 } };
      }
      const results = await this.runtime.restartServices([target]);
      this.assertRuntimeResults(results);
      return { resourceId: singleApp.id, result: { restartedServices: 1 } };
    }

    const replicas =
      appGroup.runtimeState === RuntimeState.Running &&
      singleApp.runtimeState === RuntimeState.Running &&
      !singleApp.pendingDeletion
        ? singleApp.desiredReplicas
        : 0;
    await this.applyScaleTargets([{ ...target, singleAppId, replicas }]);
    return { resourceId: singleApp.id, result: { replicas } };
  }

  private async applyScaleTargets(targets: ScaleTarget[]) {
    if (targets.length === 0) return;
    const results = await this.runtime.scaleServices(targets);
    this.assertRuntimeResults(results);
  }

  private async deployedServiceNames(appGroupId: string, currentVersion: number | null) {
    if (currentVersion === null) return new Map<string, string>();
    const deployment = await this.prisma.appGroupDeployment.findFirst({
      where: {
        appGroupId,
        version: currentVersion,
        status: DeploymentStatus.Succeeded,
      },
      select: { stackConfig: true },
    });
    if (!deployment?.stackConfig) return new Map<string, string>();
    let snapshot: RuntimeSnapshot;
    try {
      snapshot = JSON.parse(deployment.stackConfig) as RuntimeSnapshot;
    } catch {
      throw this.error("DeploymentSnapshotInvalid", "Current deployment snapshot is invalid", false);
    }
    const names = new Map<string, string>();
    for (const app of snapshot.singleApps ?? []) {
      if (typeof app.id === "string" && typeof app.name === "string") {
        names.set(app.id, app.name);
      }
    }
    return names;
  }

  private assertRuntimeResults(results: Array<{ exitCode: number; stderr: string; command: string }>) {
    const failed = results.find((result) => result.exitCode !== 0);
    if (failed) {
      throw this.error(
        "RuntimeOperationFailed",
        failed.stderr || `${failed.command} exited with ${failed.exitCode}`,
        true,
      );
    }
  }

  private input(operation: OperationRecord): Record<string, unknown> {
    return typeof operation.input === "object" && operation.input !== null
      ? (operation.input as Record<string, unknown>)
      : {};
  }

  private requireResourceId(operation: OperationRecord) {
    if (!operation.resourceId) {
      throw this.error("OperationResourceRequired", "Runtime Operation has no resource id", false);
    }
    return operation.resourceId;
  }

  private stackName(appGroupId: string) {
    return `rp_${appGroupId.replaceAll("-", "_")}`;
  }

  private serviceName(name: string) {
    return name.replaceAll("-", "_");
  }

  private error(code: string, message: string, retryable: boolean) {
    return Object.assign(new Error(message), { code, retryable });
  }
}
