import { Injectable } from "@nestjs/common";
import { AuthenticatedUser } from "../auth/types";
import { PrismaService } from "../prisma/prisma.service";
import { SWARM_CLUSTER_SINGLETON_ID } from "./swarm-infrastructure.store";

@Injectable()
export class SwarmInfrastructureAuditService {
  constructor(private readonly prisma: PrismaService) {}

  async recordDiscovered(input: {
    remoteLocationId: string;
    swarmNodeId: string;
    hostname: string;
  }) {
    await this.prisma.auditLogEntry.create({
      data: {
        tenantId: null,
        tenantName: "platform",
        actor: "system",
        actorName: "Swarm Infrastructure Reconciler",
        action: "remote-location.discovered",
        resourceType: "RemoteLocation",
        resourceId: input.remoteLocationId,
        resourceName: input.hostname,
        result: "Success",
        changes: {
          swarmNodeId: input.swarmNodeId,
        },
      },
    });
  }

  async recordRemoved(input: {
    remoteLocationId: string;
    swarmNodeId: string;
    hostname?: string;
  }) {
    await this.prisma.auditLogEntry.create({
      data: {
        tenantId: null,
        tenantName: "platform",
        actor: "system",
        actorName: "Swarm Infrastructure Reconciler",
        action: "remote-location.removed",
        resourceType: "RemoteLocation",
        resourceId: input.remoteLocationId,
        resourceName: input.hostname ?? null,
        result: "Success",
        changes: {
          swarmNodeId: input.swarmNodeId,
          status: "Removed",
        },
      },
    });
  }

  async recordReconcileFailed() {
    await this.prisma.auditLogEntry.create({
      data: {
        tenantId: null,
        tenantName: "platform",
        actor: "system",
        actorName: "Swarm Infrastructure Reconciler",
        action: "swarm.infrastructure.reconcile.failed",
        resourceType: "SwarmCluster",
        resourceId: SWARM_CLUSTER_SINGLETON_ID,
        resourceName: "global-swarm",
        result: "Failed",
        errorCode: "SWARM_OBSERVATION_FAILED",
        errorMessage: "Docker Swarm inventory observation failed",
        changes: null,
      },
    });
  }

  async recordMaintenance(input: {
    remoteLocationId: string;
    swarmNodeId: string;
    hostname: string;
    enabled: boolean;
    actor: AuthenticatedUser;
  }) {
    await this.prisma.auditLogEntry.create({
      data: {
        tenantId: null,
        tenantName: "platform",
        actor: input.actor.id,
        actorName: input.actor.displayName,
        action: input.enabled
          ? "remote-location.maintenance.enabled"
          : "remote-location.maintenance.disabled",
        resourceType: "RemoteLocation",
        resourceId: input.remoteLocationId,
        resourceName: input.hostname,
        result: "Success",
        changes: {
          swarmNodeId: input.swarmNodeId,
          maintenance: input.enabled,
          availability: input.enabled ? "Drain" : "Active",
        },
      },
    });
  }
}
