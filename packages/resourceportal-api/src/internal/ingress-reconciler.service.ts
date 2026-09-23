import { Injectable } from "@nestjs/common";
import { DeploymentStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { inspectPersistedAppGroupNetworkTopology } from "./app-group-networking";
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

      let topology: "single" | "legacy" | "pre-v020-networkless" = "legacy";
      if (currentDeployment?.renderedStack) {
        try {
          topology = inspectPersistedAppGroupNetworkTopology(
            currentDeployment.renderedStack,
            networkName,
            legacyNetworkName,
          ).mode;
        } catch {
          // Declared-but-invalid network topology is never repaired heuristically.
          // The compatibility path below is reserved for successful pre-v0.2
          // artifacts that had no top-level network declaration at all.
          failed += 1;
          continue;
        }
      }

      const singleNetwork =
        topology === "single" || topology === "pre-v020-networkless";
      if (singleNetwork) {
        const network = await this.runtime.reconcileAppGroupNetwork({
          networkName,
          traefikRequired: groupRequiresIngress,
        });
        if (!network.success) {
          failed += 1;
          continue;
        }
      } else if (groupRequiresIngress) {
        const legacy = await this.runtime.reconcileLegacyIngressNetwork({
          networkName: legacyNetworkName,
          required: true,
        });
        if (!legacy.success) {
          failed += 1;
          continue;
        }
      }

      let cleanupSafe = true;
      for (const singleApp of appGroup.singleApps) {
        checked += 1;
        const serviceName = `${stackName}_${this.serviceName(singleApp.name)}`;
        const published = hasPublishedHttpRouting(singleApp);
        let serviceChanged = false;
        let serviceFailed = false;

        const desiredMembership = await this.runtime.reconcileServiceNetwork({
          serviceName,
          networkName: singleNetwork ? networkName : legacyNetworkName,
          required: singleNetwork ? true : published,
        });
        serviceChanged ||= desiredMembership.changed;
        serviceFailed ||= !desiredMembership.success;

        // Never repoint Traefik to a network that Docker failed to attach.
        if (serviceFailed) {
          cleanupSafe = false;
          if (serviceChanged) changed += 1;
          failed += 1;
          continue;
        }

        const desiredLabels =
          renderTraefikLabels(singleApp, {
            certResolver: process.env.TRAEFIK_CERT_RESOLVER,
            swarmNetwork: singleNetwork ? networkName : legacyNetworkName,
          }) ?? {};
        const labels = await this.runtime.reconcileTraefikLabels({
          serviceName,
          desiredLabels,
        });
        serviceChanged ||= labels.changed;
        serviceFailed ||= !labels.success;

        // Obsolete network membership is removed only after routing labels point
        // at the desired isolated network, preventing a migration outage.
        if (singleNetwork && labels.success) {
          const legacyMembership = await this.runtime.reconcileServiceNetwork({
            serviceName,
            networkName: legacyNetworkName,
            required: false,
          });
          serviceChanged ||= legacyMembership.changed;
          serviceFailed ||= !legacyMembership.success;

          if (topology === "pre-v020-networkless") {
            const sharedIngress =
              await this.runtime.detachServiceFromPreV020SharedIngress({
                serviceName,
              });
            serviceChanged ||= sharedIngress.changed;
            serviceFailed ||= !sharedIngress.success;
          }
        }

        if (serviceChanged) changed += 1;
        if (serviceFailed) {
          failed += 1;
          cleanupSafe = false;
        }
      }

      if (singleNetwork && cleanupSafe) {
        const cleanup = await this.runtime.reconcileLegacyIngressNetwork({
          networkName: legacyNetworkName,
          required: false,
        });
        if (!cleanup.success) failed += 1;
      } else if (!singleNetwork && !groupRequiresIngress) {
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
