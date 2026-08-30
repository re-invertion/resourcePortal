import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { renderTraefikLabels } from "./traefik-routing";
import { StackRuntimeService } from "./stack-runtime.service";

@Injectable()
export class IngressReconcilerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runtime: StackRuntimeService,
  ) {}

  async reconcileBatch() {
    const appGroups = await this.prisma.appGroup.findMany({
      where: {
        currentDeploymentVersion: { not: null },
      },
      include: {
        singleApps: {
          where: { pendingDeletion: false },
          include: {
            httpEndpoints: {
              include: {
                domains: {
                  select: { hostname: true },
                },
              },
            },
          },
        },
      },
    });

    let checked = 0;
    let changed = 0;
    let failed = 0;

    for (const appGroup of appGroups) {
      const stackName = this.stackName(appGroup.id);
      for (const singleApp of appGroup.singleApps) {
        checked += 1;
        const desiredLabels =
          renderTraefikLabels({
            name: singleApp.name,
            httpEndpoints: singleApp.httpEndpoints,
          }) ?? {};
        const result = await this.runtime.reconcileTraefikLabels({
          serviceName: `${stackName}_${this.serviceName(singleApp.name)}`,
          desiredLabels,
        });

        if (!result.success) {
          failed += 1;
          continue;
        }
        if (result.changed) {
          changed += 1;
        }
      }
    }

    return { checked, changed, failed };
  }

  private stackName(appGroupId: string) {
    return `rp_${appGroupId.replaceAll("-", "_")}`;
  }

  private serviceName(name: string) {
    return name.replaceAll("-", "_");
  }
}
