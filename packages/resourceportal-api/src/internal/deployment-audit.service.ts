import { Injectable, NotFoundException } from "@nestjs/common";
import { DeploymentStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

const TERMINAL_FAILURE_STATUSES = new Set<DeploymentStatus>([
  DeploymentStatus.Failed,
  DeploymentStatus.RolledBack,
  DeploymentStatus.RollbackFailed,
]);

@Injectable()
export class DeploymentAuditService {
  constructor(private readonly prisma: PrismaService) {}

  async recordStarted(deploymentId: string) {
    const deployment = await this.findDeployment(deploymentId);
    const action = "appgroup.deploy.started";

    if (await this.exists(deployment.appGroup.tenantId, deployment.correlationId, action)) {
      return;
    }

    await this.prisma.auditLogEntry.create({
      data: this.auditData(deployment, {
        action,
        result: "Success",
      }),
    });
  }

  async recordOutcome(deploymentId: string) {
    const deployment = await this.findDeployment(deploymentId);
    const succeeded = deployment.status === DeploymentStatus.Succeeded;
    const failed = TERMINAL_FAILURE_STATUSES.has(deployment.status);

    if (!succeeded && !failed) {
      return;
    }

    const action = succeeded
      ? "appgroup.deploy.succeeded"
      : "appgroup.deploy.failed";

    if (await this.exists(deployment.appGroup.tenantId, deployment.correlationId, action)) {
      return;
    }

    await this.prisma.auditLogEntry.create({
      data: this.auditData(deployment, {
        action,
        result: succeeded ? "Success" : "Failed",
        errorCode: failed ? deployment.errorCode : null,
        errorMessage: failed ? deployment.errorMessage : null,
      }),
    });
  }

  private async findDeployment(deploymentId: string) {
    const deployment = await this.prisma.appGroupDeployment.findUnique({
      where: { id: deploymentId },
      include: {
        appGroup: {
          select: {
            id: true,
            name: true,
            tenantId: true,
            tenant: {
              select: { name: true },
            },
          },
        },
      },
    });

    if (!deployment) {
      throw new NotFoundException("Deployment not found");
    }

    return deployment;
  }

  private exists(tenantId: string, correlationId: string, action: string) {
    return this.prisma.auditLogEntry.findFirst({
      where: {
        tenantId,
        correlationId,
        action,
        actor: "system",
      },
      select: { id: true },
    });
  }

  private auditData(
    deployment: Awaited<ReturnType<DeploymentAuditService["findDeployment"]>>,
    event: {
      action: string;
      result: "Success" | "Failed";
      errorCode?: string | null;
      errorMessage?: string | null;
    },
  ) {
    return {
      tenantId: deployment.appGroup.tenantId,
      tenantName: deployment.appGroup.tenant.name,
      actor: "system",
      actorName: "Deployment Worker",
      action: event.action,
      resourceType: "AppGroup",
      resourceId: deployment.appGroup.id,
      resourceName: deployment.appGroup.name,
      result: event.result,
      errorCode: event.errorCode ?? null,
      errorMessage: event.errorMessage ?? null,
      requestId: null,
      correlationId: deployment.correlationId,
      ipAddress: null,
      userAgent: null,
      changes: {
        deploymentId: deployment.id,
        version: deployment.version,
        status: deployment.status,
        phase: deployment.phase,
        rollbackTargetVersion: deployment.rollbackTargetVersion,
      },
    };
  }
}
