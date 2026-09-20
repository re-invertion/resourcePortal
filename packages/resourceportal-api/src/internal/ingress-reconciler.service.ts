import { Injectable } from "@nestjs/common";
import { DeploymentStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { inspectAppGroupNetworkTopology } from "./app-group-networking";
import {
  appGroupNetworkName,
  hasPublishedHttpRouting,
  legacyAppGroupIngressNetworkName,
  renderTraefikLabels,
} from "./traefik-routing";
import { StackRuntimeService } from "./stack-runtime.service";

@Injectable()
export class IngressReconcilerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runtime: StackRuntimeService,
  ) {}

  async reconcileBatch(input?: { appGroupId?: string }) {
    const appGroups = await this.prisma.appGroup.findMany({
      where: {
        currentDeploymentVersion: { not: null },
        ...(input?.appGroupId ? { id: input.appGroupId } : {}),
      },
      include: {
        deployments: {
          where: { status: DeploymentStatus.Succeeded },
          select: { version: true, renderedStack: true },
          orderBy: { version: "desc" },
        },
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
      const networkName = appGroupNetworkName(appGroup.id);
      const legacyNetworkName = legacyAppGroupIngressNetworkName(appGroup.id);
      const groupRequiresIngress = appGroup.singleApps.some((singleApp) =>
        hasPublishedHttpRouting(singleApp),
      );
      const currentDeployment = appGroup.deployments.find(
        (deployment) =>
          deployment.version === appGroup.currentDeploymentVersion,
      );

      let topology: "single" | "legacy" = "legacy";
      if (currentDeployment?.renderedStack) {
        try {
          topology = inspectAppGroupNetworkTopology(
            currentDeployment.renderedStack,
            networkName,
            legacyNetworkName,
          ).mode;
        } catch {
          // Do not mutate network topology when the persisted deployment artifact
          // cannot be classified safely. Exact artifact integrity wins over repair.
          failed += 1;
          continue;
        }
      }

      if (topology === "single") {
        const network = await this.runtime.reconcileAppGroupNetwork({
          networkName,
          traefikRequired: groupRequiresIngress,
        });
        if (!network.success) failed += 1;
      } else if (groupRequiresIngress) {
        const legacy = await this.runtime.reconcileLegacyIngressNetwork({
          networkName: legacyNetworkName,
          required: true,
        });
        if (!legacy.success) failed += 1;
      }

      for (const singleApp of appGroup.singleApps) {
        checked += 1;
        const serviceName = `${stackName}_${this.serviceName(singleApp.name)}`;
        const published = hasPublishedHttpRouting(singleApp);
        let serviceChanged = false;
        let serviceFailed = false;

        if (topology === "single") {
          const membership = await this.runtime.reconcileServiceNetwork({
            serviceName,
            networkName,
            required: true,
          });
          serviceChanged ||= membership.changed;
          serviceFailed ||= !membership.success;

          const legacyMembership = await this.runtime.reconcileServiceNetwork({
            serviceName,
            networkName: legacyNetworkName,
            required: false,
          });
          serviceChanged ||= legacyMembership.changed;
          serviceFailed ||= !legacyMembership.success;
        } else {
          const legacyMembership = await this.runtime.reconcileServiceNetwork({
            serviceName,
            networkName: legacyNetworkName,
            required: published,
          });
          serviceChanged ||= legacyMembership.changed;
          serviceFailed ||= !legacyMembership.success;
        }

        const desiredLabels =
          renderTraefikLabels(singleApp, {
            certResolver: process.env.TRAEFIK_CERT_RESOLVER,
            swarmNetwork:
              topology === "single" ? networkName : legacyNetworkName,
          }) ?? {};
        const labels = await this.runtime.reconcileTraefikLabels({
          serviceName,
          desiredLabels,
        });
        serviceChanged ||= labels.changed;
        serviceFailed ||= !labels.success;

        if (serviceChanged) changed += 1;
        if (serviceFailed) failed += 1;
      }

      if (topology === "single") {
        const cleanup = await this.runtime.reconcileLegacyIngressNetwork({
          networkName: legacyNetworkName,
          required: false,
        });
        if (!cleanup.success) failed += 1;
      } else if (!groupRequiresIngress) {
        const cleanup = await this.runtime.reconcileLegacyIngressNetwork({
          networkName: legacyNetworkName,
          required: false,
        });
        if (!cleanup.success) failed += 1;
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
