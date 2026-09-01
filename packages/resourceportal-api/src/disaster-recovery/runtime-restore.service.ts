import { Injectable } from "@nestjs/common";
import { DeploymentStatus } from "@prisma/client";
import { StackApplyService } from "../internal/stack-apply.service";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class RuntimeRestoreService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stackApply: StackApplyService,
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
            renderedStack: true,
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

      if (!deployment?.renderedStack) {
        skipped += 1;
        continue;
      }

      const result = await this.stackApply.applyStack({
        stackName: this.stackName(appGroup.id),
        renderedStack: deployment.renderedStack,
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
