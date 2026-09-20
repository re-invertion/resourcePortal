import { Injectable } from "@nestjs/common";
import { DeploymentStatus } from "@prisma/client";
import { DeploymentExecutionService } from "../internal/deployment-execution.service";
import { StackApplyService } from "../internal/stack-apply.service";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class RuntimeRestoreService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stackApply: StackApplyService,
    private readonly deploymentExecution: DeploymentExecutionService,
  ) {}

  async reconcile() {
    const appGroups = await this.prisma.appGroup.findMany({
      where: { currentDeploymentVersion: { not: null } },
      select: {
        id: true,
        currentDeploymentVersion: true,
        deployments: {
          where: { status: DeploymentStatus.Succeeded },
          select: {
            id: true,
            version: true,
            status: true,
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

      const result = await this.stackApply.applyStack({
        stackName: this.stackName(appGroup.id),
        renderedStack: artifact.renderedStack,
        artifactSha256: artifact.sha256,
        appGroupId: appGroup.id,
      });

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
