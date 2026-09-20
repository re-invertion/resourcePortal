import { Injectable } from "@nestjs/common";
import { DeploymentPhase, DeploymentStatus } from "@prisma/client";
import { DeploymentAuditService } from "../../internal/deployment-audit.service";
import { DeploymentRecoveryService } from "../../internal/deployment-recovery.service";
import { DeploymentExecutionService } from "../../internal/deployment-execution.service";
import type { OperationExecutor } from "../operation-executor";
import type {
  OperationExecutionResult,
  OperationRecord,
  OperationType,
} from "../operation.types";

type DeploymentExecution = {
  id: string;
  version: number;
  status: DeploymentStatus;
  phase: DeploymentPhase;
  rollbackTargetVersion: number | null;
  errorCode: string | null;
  errorMessage: string | null;
};

@Injectable()
export class DeploymentOperationExecutor implements OperationExecutor {
  readonly types = ["APP_GROUP_DEPLOY", "APP_GROUP_ROLLBACK"] as const satisfies readonly OperationType[];

  constructor(
    private readonly recovery: DeploymentRecoveryService,
    private readonly worker: DeploymentExecutionService,
    private readonly audit: DeploymentAuditService,
  ) {}

  async execute(operation: OperationRecord): Promise<OperationExecutionResult> {
    const deploymentId = this.requireDeploymentId(operation);
    const workerId = operation.leaseOwner;
    if (!workerId) {
      throw this.executionError("OperationLeaseMissing", "Deployment Operation has no lease owner", true);
    }
    const leaseSeconds = this.leaseSeconds(operation);

    let deployment = (await this.recovery.claimDeploymentById(deploymentId, {
      workerId,
      leaseSeconds,
    })) as DeploymentExecution;

    if (this.isTerminal(deployment.status)) {
      return this.terminalResult(operation, deployment);
    }

    await this.audit.recordStarted(deploymentId).catch(() => undefined);

    const recovered = (await this.recovery.reconcileClaimedDeployment(
      deploymentId,
      workerId,
    )) as DeploymentExecution | null;
    if (!recovered) {
      throw this.executionError(
        "DeploymentRecoveryDeferred",
        "Deployment recovery could not safely determine runtime state yet",
        true,
      );
    }
    deployment = recovered;

    for (const phase of this.remainingPhases(deployment.phase)) {
      if (this.isTerminal(deployment.status)) break;
      await this.worker.heartbeatDeployment(deploymentId, { workerId, leaseSeconds });
      deployment = await this.worker.advanceDeployment(deploymentId, {
        workerId,
        phase,
        message: `Operation ${operation.id} advanced deployment to ${phase}`,
      });
    }

    await this.audit.recordOutcome(deploymentId).catch(() => undefined);
    return this.terminalResult(operation, deployment);
  }

  private terminalResult(
    operation: OperationRecord,
    deployment: DeploymentExecution,
  ): OperationExecutionResult {
    if (deployment.status === DeploymentStatus.Failed) {
      throw this.executionError(
        deployment.errorCode ?? "DeploymentFailed",
        deployment.errorMessage ?? "App Group deployment failed",
        false,
      );
    }
    if (deployment.status === DeploymentStatus.RollbackFailed) {
      throw this.executionError(
        deployment.errorCode ?? "RollbackFailed",
        deployment.errorMessage ?? "App Group rollback failed",
        false,
      );
    }
    if (!this.isTerminal(deployment.status)) {
      throw this.executionError(
        "DeploymentIncomplete",
        `Deployment stopped in ${deployment.status}/${deployment.phase}`,
        true,
      );
    }

    const rollback =
      operation.type === "APP_GROUP_ROLLBACK" ||
      deployment.status === DeploymentStatus.RolledBack;
    return {
      resourceId: deployment.id,
      terminalStatus: rollback ? "RolledBack" : "Succeeded",
      result: {
        deploymentId: deployment.id,
        version: deployment.version,
        deploymentStatus: deployment.status,
        phase: deployment.phase,
        rollbackTargetVersion: deployment.rollbackTargetVersion,
      },
    };
  }

  private remainingPhases(phase: DeploymentPhase) {
    switch (phase) {
      case DeploymentPhase.Validating:
        return [
          DeploymentPhase.PreparingArtifacts,
          DeploymentPhase.GeneratingStack,
          DeploymentPhase.ApplyingStack,
          DeploymentPhase.WaitingForRollout,
        ];
      case DeploymentPhase.PreparingArtifacts:
        return [
          DeploymentPhase.GeneratingStack,
          DeploymentPhase.ApplyingStack,
          DeploymentPhase.WaitingForRollout,
        ];
      case DeploymentPhase.GeneratingStack:
        return [DeploymentPhase.ApplyingStack, DeploymentPhase.WaitingForRollout];
      case DeploymentPhase.ApplyingStack:
        return [DeploymentPhase.WaitingForRollout];
      case DeploymentPhase.Cleanup:
        return [DeploymentPhase.Completed];
      case DeploymentPhase.WaitingForRollout:
      case DeploymentPhase.RollingBack:
      case DeploymentPhase.Completed:
        return [];
    }
  }

  private isTerminal(status: DeploymentStatus) {
    return (
      status === DeploymentStatus.Succeeded ||
      status === DeploymentStatus.Failed ||
      status === DeploymentStatus.RolledBack ||
      status === DeploymentStatus.RollbackFailed
    );
  }

  private requireDeploymentId(operation: OperationRecord) {
    if (!operation.resourceId) {
      throw this.executionError("OperationResourceRequired", "Deployment Operation has no deployment id", false);
    }
    return operation.resourceId;
  }

  private leaseSeconds(operation: OperationRecord) {
    if (!operation.leaseExpiresAt) return 300;
    return Math.max(
      15,
      Math.ceil((operation.leaseExpiresAt.getTime() - Date.now()) / 1000),
    );
  }

  private executionError(code: string, message: string, retryable: boolean) {
    return Object.assign(new Error(message), { code, retryable });
  }
}
