import { Injectable } from "@nestjs/common";
import { DeploymentStatus } from "@prisma/client";
import { DeploymentExecutionService } from "../internal/deployment-execution.service";
import { PrismaService } from "../prisma/prisma.service";
import { PlatformMaintenanceService } from "../platform-maintenance/platform-maintenance.service";
import { runtimeSafeRestoreArtifact } from "./runtime-restore-policy";

@Injectable()
export class RuntimeRestoreService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly deploymentExecution: DeploymentExecutionService,
    private readonly maintenance: PlatformMaintenanceService,
  ) {}

  async reconcile() {
    const maintenance = await this.maintenance.getState();
    const appGroups = await this.prisma.appGroup.findMany({
      where: { currentDeploymentVersion: { not: null } },
      select: {
        id: true,
        status: true,
        runtimeState: true,
        currentDeploymentVersion: true,
        tenant: { select: { status: true, billing: { select: { balance: true } } } },
        singleApps: { select: { id: true, runtimeState: true, pendingDeletion: true } },
        deployments: {
          where: { status: DeploymentStatus.Succeeded },
          select: {
            id: true,
            version: true,
            status: true,
            stackConfig: true,
          },
        },
      },
    });

    let applied = 0;
    let failed = 0;
    let skipped = 0;

    for (const appGroup of appGroups) {
      const deployment = appGroup.deployments.find(
        (candidate) => candidate.version === appGroup.currentDeploymentVersion,
      );

      if (!deployment) {
        skipped += 1;
        continue;
      }

      let artifact: { renderedStack: string; sha256: string };
      try {
        artifact = await this.deploymentExecution.ensureDeploymentArtifact(
          deployment.id,
        );
      } catch {
        failed += 1;
        continue;
      }

      // Do not resurrect workloads stopped after their last successful deploy,
      // or blocked by maintenance, billing, tenant suspension, or deletion.
      const blocked = maintenance.enabled ||
        appGroup.status === "Deleting" ||
        appGroup.status === "Error" ||
        appGroup.runtimeState === "Stopped" ||
        appGroup.tenant?.status === "Suspended" ||
        (appGroup.tenant?.billing?.balance.lte(0) ?? false);
      let safeArtifact: typeof artifact;
      try {
        safeArtifact = runtimeSafeRestoreArtifact(artifact, deployment.stackConfig, {
          blocked,
          singleApps: appGroup.singleApps,
        });
      } catch {
        failed += 1;
        continue;
      }

      const result = await this.deploymentExecution.applyDeploymentArtifactWithRegistryAuth(
        deployment.stackConfig,
        {
          stackName: this.stackName(appGroup.id),
          renderedStack: safeArtifact.renderedStack,
          artifactSha256: safeArtifact.sha256,
          appGroupId: appGroup.id,
        },
      );

      if (result.exitCode === 0) {
        applied += 1;
      } else {
        failed += 1;
      }
    }

    return {
      checked: appGroups.length,
      applied,
      failed,
      skipped,
    };
  }

  private stackName(appGroupId: string) {
    return `rp_${appGroupId.replaceAll("-", "_")}`;
  }
}
