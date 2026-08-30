import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  AppGroupDeployment,
  DeploymentPhase,
  DeploymentStatus,
  Prisma,
} from "@prisma/client";
import {
  deriveAppGroupDriftStatus,
  ExpectedRuntimeService,
} from "../app-groups/runtime-drift";
import { mapAppGroupDeployment } from "../app-groups/app-groups.view";
import { PrismaService } from "../prisma/prisma.service";
import { DeploymentWorkerService } from "./deployment-worker.service";
import { StackApplyService } from "./stack-apply.service";
import { StackRolloutService } from "./stack-rollout.service";
import { StackRuntimeService } from "./stack-runtime.service";

type RecoverySnapshot = {
  appGroup: {
    runtimeState: string;
  };
  singleApps: Array<{
    id: string;
    name: string;
    image: string;
    desiredReplicas: number;
    runtimeState: string;
  }>;
};

type RollbackTarget = AppGroupDeployment & {
  stackConfig: string;
};

@Injectable()
export class DeploymentRecoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly worker: DeploymentWorkerService,
    private readonly stackApply: StackApplyService,
    private readonly stackRollout: StackRolloutService,
    private readonly stackRuntime: StackRuntimeService,
  ) {}

  async reconcileClaimedDeployment(deploymentId: string, workerId: string) {
    const deployment = await this.findClaimedDeployment(deploymentId, workerId);

    if (deployment.status === DeploymentStatus.RollingBack) {
      return this.recoverRollback(deployment, workerId);
    }

    switch (deployment.phase) {
      case DeploymentPhase.Validating:
      case DeploymentPhase.GeneratingStack:
      case DeploymentPhase.Cleanup:
      case DeploymentPhase.Completed:
        return mapAppGroupDeployment(deployment);
      case DeploymentPhase.PreparingArtifacts:
        await this.recordEvent(deployment.id, deployment.phase, "Info",
          "Worker recovery is replaying idempotent artifact provisioning",
        );
        return this.worker.resumeArtifactProvisioning(deployment.id, workerId);
      case DeploymentPhase.ApplyingStack:
        return this.reconcileApplyingStack(deployment, workerId);
      case DeploymentPhase.WaitingForRollout:
        return this.reconcileWaitingForRollout(deployment, workerId);
      case DeploymentPhase.RollingBack:
        throw new ConflictException(
          "Deploying deployment cannot be in RollingBack phase",
        );
    }
  }

  private async reconcileApplyingStack(
    deployment: AppGroupDeployment,
    workerId: string,
  ) {
    const snapshot = this.parseSnapshot(deployment.stackConfig);
    const observed = await this.inspectDeploymentRuntime(deployment, snapshot);

    if (observed === null) {
      return this.deferRecovery(
        deployment,
        "Docker Swarm state could not be inspected before resuming stack apply",
      );
    }

    if (observed === "InSync") {
      await this.recordEvent(
        deployment.id,
        DeploymentPhase.ApplyingStack,
        "Info",
        "Worker recovery found the desired stack already applied; skipping duplicate docker stack deploy",
      );
      return mapAppGroupDeployment(deployment);
    }

    await this.recordEvent(
      deployment.id,
      DeploymentPhase.ApplyingStack,
      "Warning",
      "Worker recovery observed an incomplete stack apply; reconciling desired stack after inspection",
    );
    return this.worker.resumeStackApply(deployment.id, workerId);
  }

  private async reconcileWaitingForRollout(
    deployment: AppGroupDeployment,
    workerId: string,
  ) {
    const snapshot = this.parseSnapshot(deployment.stackConfig);
    const observed = await this.inspectDeploymentRuntime(deployment, snapshot);

    if (observed === null) {
      return this.deferRecovery(
        deployment,
        "Docker Swarm state could not be inspected before resuming rollout",
      );
    }

    if (observed !== "InSync") {
      await this.recordEvent(
        deployment.id,
        DeploymentPhase.WaitingForRollout,
        "Warning",
        "Worker recovery observed runtime drift during rollout; reconciling desired stack after inspection",
      );
      const applied = await this.worker.resumeStackApply(deployment.id, workerId);

      if (this.isTerminalStatus(applied.status)) {
        return applied;
      }
    } else {
      await this.recordEvent(
        deployment.id,
        DeploymentPhase.WaitingForRollout,
        "Info",
        "Worker recovery found the desired stack present; resuming rollout observation without duplicate apply",
      );
    }

    return this.worker.resumeRollout(deployment.id, workerId);
  }

  private async recoverRollback(
    deployment: AppGroupDeployment,
    workerId: string,
  ) {
    if (deployment.rollbackTargetVersion === null) {
      return this.markRollbackFailed(
        deployment,
        "Rollback target version is missing during worker recovery",
      );
    }

    const rollbackTarget = await this.prisma.appGroupDeployment.findFirst({
      where: {
        appGroupId: deployment.appGroupId,
        version: deployment.rollbackTargetVersion,
        status: DeploymentStatus.Succeeded,
        stackConfig: { not: null },
      },
    });

    if (!rollbackTarget?.stackConfig) {
      return this.markRollbackFailed(
        deployment,
        `Rollback target v${deployment.rollbackTargetVersion} is unavailable during worker recovery`,
      );
    }

    const target = rollbackTarget as RollbackTarget;
    const failedSnapshot = this.parseSnapshot(deployment.stackConfig);
    const rollbackSnapshot = this.parseSnapshot(target.stackConfig);
    const observed = await this.inspectDeploymentRuntime(target, rollbackSnapshot);

    if (observed === null) {
      return this.deferRecovery(
        deployment,
        "Docker Swarm state could not be inspected before resuming rollback",
      );
    }

    const stackName = this.stackName(deployment.appGroupId);

    if (observed !== "InSync") {
      await this.recordEvent(
        deployment.id,
        DeploymentPhase.RollingBack,
        "Warning",
        `Worker recovery observed an incomplete rollback to v${target.version}; reconciling rollback target after inspection`,
      );
      const renderedStack =
        target.renderedStack ?? this.worker.renderStackForRecovery(target.stackConfig);
      const applyResult = await this.stackApply.applyStack({
        stackName,
        renderedStack,
      });

      if (applyResult.exitCode !== 0) {
        return this.markRollbackFailed(
          deployment,
          `Rollback stack deploy failed\n${applyResult.command}\n${
            applyResult.stderr ||
            applyResult.stdout ||
            `Exit code ${applyResult.exitCode}`
          }`,
        );
      }
    } else {
      await this.recordEvent(
        deployment.id,
        DeploymentPhase.RollingBack,
        "Info",
        `Worker recovery found rollback target v${target.version} already applied; skipping duplicate stack deploy`,
      );
    }

    const rolloutResult = await this.stackRollout.waitForRollout({
      stackName,
      expectedServices: this.expectedRuntimeServices(
        stackName,
        rollbackSnapshot,
      ).map((service) => ({
        name: service.name,
        desiredReplicas: service.desiredReplicas,
      })),
    });

    if (!rolloutResult.success) {
      return this.markRollbackFailed(
        deployment,
        `${rolloutResult.message}\n${rolloutResult.details}`,
      );
    }

    return this.completeRollback(
      deployment,
      failedSnapshot,
      target,
      rollbackSnapshot,
      rolloutResult,
    );
  }

  private async findClaimedDeployment(deploymentId: string, workerId: string) {
    const deployment = await this.prisma.appGroupDeployment.findUnique({
      where: { id: deploymentId },
    });

    if (!deployment) {
      throw new NotFoundException("Deployment not found");
    }

    if (
      deployment.status !== DeploymentStatus.Deploying &&
      deployment.status !== DeploymentStatus.RollingBack
    ) {
      throw new ConflictException(
        `Deployment is not recoverable: ${deployment.status}`,
      );
    }

    if (deployment.leaseOwner !== workerId) {
      throw new ConflictException("Deployment is leased by another worker");
    }

    return deployment;
  }

  private async inspectDeploymentRuntime(
    deployment: Pick<AppGroupDeployment, "appGroupId">,
    snapshot: RecoverySnapshot,
  ) {
    const stackName = this.stackName(deployment.appGroupId);
    const expected = this.expectedRuntimeServices(stackName, snapshot);
    const observed = await this.stackRuntime.inspectStackServices(stackName);

    if (observed === null) {
      return null;
    }

    return deriveAppGroupDriftStatus(expected, observed);
  }

  private expectedRuntimeServices(
    stackName: string,
    snapshot: RecoverySnapshot,
  ): ExpectedRuntimeService[] {
    return snapshot.singleApps.map((singleApp) => ({
      name: `${stackName}_${this.serviceName(singleApp.name)}`,
      image: singleApp.image,
      desiredReplicas: this.effectiveReplicas(snapshot, singleApp),
    }));
  }

  private async deferRecovery(deployment: AppGroupDeployment, message: string) {
    await this.prisma.$transaction(async (tx) => {
      const released = await tx.appGroupDeployment.updateMany({
        where: {
          id: deployment.id,
          status: deployment.status,
          leaseOwner: deployment.leaseOwner,
        },
        data: {
          leaseOwner: null,
          leaseExpiresAt: new Date(0),
          heartbeatAt: null,
        },
      });

      if (released.count === 1) {
        await this.createEvent(tx, deployment.id, {
          phase: deployment.phase,
          level: "Warning",
          message: `Worker recovery deferred: ${message}`,
        });
      }
    });

    return null;
  }

  private async completeRollback(
    deployment: AppGroupDeployment,
    failedSnapshot: RecoverySnapshot,
    rollbackTarget: RollbackTarget,
    rollbackSnapshot: RecoverySnapshot,
    rolloutResult: { message: string; details: string },
  ) {
    const rolledBack = await this.prisma.$transaction(async (tx) => {
      for (const singleApp of failedSnapshot.singleApps) {
        await tx.singleApp.updateMany({
          where: { id: singleApp.id },
          data: {
            actualReplicas: 0,
            health: "Unknown",
          },
        });
      }

      for (const singleApp of rollbackSnapshot.singleApps) {
        await tx.singleApp.updateMany({
          where: { id: singleApp.id },
          data: {
            actualReplicas: this.effectiveReplicas(
              rollbackSnapshot,
              singleApp,
            ),
            health: "Healthy",
          },
        });
      }

      const next = await tx.appGroupDeployment.update({
        where: { id: deployment.id },
        data: {
          status: DeploymentStatus.RolledBack,
          phase: DeploymentPhase.Completed,
          completedAt: new Date(),
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
        },
      });

      await tx.appGroup.update({
        where: { id: deployment.appGroupId },
        data: {
          currentDeploymentVersion: rollbackTarget.version,
          hasPendingChanges: true,
          health: "Healthy",
          driftStatus: "InSync",
        },
      });

      await this.createEvent(tx, deployment.id, {
        phase: DeploymentPhase.Completed,
        level: "Info",
        message: this.truncate(
          `Worker recovery completed rollback to deployment v${rollbackTarget.version}\n${rolloutResult.message}\n${rolloutResult.details}`,
          2000,
        ),
      });

      return next;
    });

    return mapAppGroupDeployment(rolledBack);
  }

  private async markRollbackFailed(
    deployment: AppGroupDeployment,
    message: string,
  ) {
    const failed = await this.prisma.$transaction(async (tx) => {
      const next = await tx.appGroupDeployment.update({
        where: { id: deployment.id },
        data: {
          status: DeploymentStatus.RollbackFailed,
          phase: DeploymentPhase.Completed,
          errorCode: "RollbackFailed",
          errorMessage: this.truncate(message, 2000),
          completedAt: new Date(),
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          appGroup: {
            update: {
              status: "Error",
              health: "Unhealthy",
              driftStatus: "Unknown",
            },
          },
        },
      });

      await this.createEvent(tx, deployment.id, {
        phase: DeploymentPhase.Completed,
        level: "Error",
        message: this.truncate(
          `Rollback to deployment v${deployment.rollbackTargetVersion ?? "unknown"} failed during worker recovery\n${message}`,
          2000,
        ),
      });

      return next;
    });

    return mapAppGroupDeployment(failed);
  }

  private recordEvent(
    deploymentId: string,
    phase: DeploymentPhase,
    level: "Info" | "Warning" | "Error",
    message: string,
  ) {
    return this.prisma.deploymentEvent.create({
      data: {
        deploymentId,
        phase,
        level,
        message: this.truncate(message, 2000),
      },
    });
  }

  private createEvent(
    tx: Prisma.TransactionClient,
    deploymentId: string,
    event: {
      phase: DeploymentPhase;
      level: "Info" | "Warning" | "Error";
      message: string;
    },
  ) {
    return tx.deploymentEvent.create({
      data: {
        deploymentId,
        phase: event.phase,
        level: event.level,
        message: this.truncate(event.message, 2000),
      },
    });
  }

  private parseSnapshot(stackConfig: string | null) {
    if (!stackConfig) {
      throw new ConflictException("Deployment has no stack config");
    }

    return JSON.parse(stackConfig) as RecoverySnapshot;
  }

  private effectiveReplicas(
    snapshot: RecoverySnapshot,
    singleApp: RecoverySnapshot["singleApps"][number],
  ) {
    if (
      snapshot.appGroup.runtimeState !== "Running" ||
      singleApp.runtimeState !== "Running"
    ) {
      return 0;
    }

    return singleApp.desiredReplicas;
  }

  private isTerminalStatus(status: DeploymentStatus) {
    return (
      status === DeploymentStatus.Succeeded ||
      status === DeploymentStatus.Failed ||
      status === DeploymentStatus.RolledBack ||
      status === DeploymentStatus.RollbackFailed
    );
  }

  private stackName(appGroupId: string) {
    return `rp_${appGroupId.replaceAll("-", "_")}`;
  }

  private serviceName(name: string) {
    return name.replaceAll("-", "_");
  }

  private truncate(value: string, maxLength: number) {
    return value.length > maxLength ? value.slice(0, maxLength) : value;
  }
}
