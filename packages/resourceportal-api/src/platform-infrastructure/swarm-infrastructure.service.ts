import {
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { AuthenticatedUser } from "../auth/types";
import { DockerSwarmInfrastructureService } from "./docker-swarm-infrastructure.service";
import { SwarmInfrastructureAuditService } from "./swarm-infrastructure-audit.service";
import {
  deriveRemoteLocationHealth,
  deriveSwarmClusterHealth,
  parseNodeCapabilities,
  planInventoryReconciliation,
} from "./swarm-infrastructure.logic";
import {
  RemoteLocationRow,
  SwarmInfrastructureStore,
} from "./swarm-infrastructure.store";

@Injectable()
export class SwarmInfrastructureService {
  constructor(
    private readonly store: SwarmInfrastructureStore,
    private readonly docker: DockerSwarmInfrastructureService,
    private readonly audit: SwarmInfrastructureAuditService,
  ) {}

  async getCluster() {
    const cluster = await this.store.getCluster();
    if (!cluster) {
      throw new NotFoundException("Swarm cluster has not been reconciled yet");
    }
    return cluster;
  }

  async listRemoteLocations() {
    const remoteLocations = await this.store.listRemoteLocations();
    return remoteLocations.map((remoteLocation) =>
      this.mapRemoteLocation(remoteLocation),
    );
  }

  async getRemoteLocation(id: string) {
    const remoteLocation = await this.store.getRemoteLocation(id);
    if (!remoteLocation) {
      throw new NotFoundException("Remote Location not found");
    }
    return this.mapRemoteLocation(remoteLocation);
  }

  async reconcile() {
    const swarm = await this.docker.inspectSwarm();
    if (!swarm) {
      return this.failReconcile();
    }

    const nodes = await this.docker.listNodes();
    if (!nodes) {
      return this.failReconcile();
    }

    const existing = await this.store.listRemoteLocations();
    const plan = planInventoryReconciliation(existing, nodes);
    const existingByNodeId = new Map(
      existing.map((remoteLocation) => [
        remoteLocation.swarmNodeId,
        remoteLocation,
      ]),
    );
    const observationByNodeId = new Map(
      plan.observations.map((observation) => [
        observation.swarmNodeId,
        observation,
      ]),
    );
    const now = new Date();

    for (const node of nodes) {
      const observation = observationByNodeId.get(node.swarmNodeId);
      if (!observation) {
        continue;
      }

      const current = existingByNodeId.get(node.swarmNodeId);
      const capabilities = parseNodeCapabilities(node.labels);
      const maintenance =
        node.availability === "Drain" && current?.maintenance === true;
      const id = observation.remoteLocationId ?? randomUUID();

      await this.store.upsertRemoteLocation({
        id,
        swarmNodeId: node.swarmNodeId,
        hostname: node.hostname,
        role: node.role,
        status: node.status,
        availability: node.availability,
        health: deriveRemoteLocationHealth(node.status, node.availability),
        maintenance,
        cpuNano: node.cpuNano,
        memoryBytes: node.memoryBytes,
        gpuCount: capabilities.gpuCount,
        networkCapabilities: capabilities.networkCapabilities,
        lastSeenAt: now,
      });

      if (observation.discovered) {
        await this.audit.recordDiscovered({
          remoteLocationId: id,
          swarmNodeId: node.swarmNodeId,
          hostname: node.hostname,
        });
      }
    }

    for (const removed of plan.removed) {
      const current = existingByNodeId.get(removed.swarmNodeId);
      await this.store.markRemoteLocationRemoved(removed.id);
      await this.audit.recordRemoved({
        remoteLocationId: removed.id,
        swarmNodeId: removed.swarmNodeId,
        hostname: current?.hostname,
      });
    }

    const health = deriveSwarmClusterHealth(nodes);
    const managerCount = nodes.filter((node) => node.role === "Manager").length;

    await this.store.saveCluster({
      dockerClusterId: swarm.dockerClusterId,
      health,
      managerCount,
      nodeCount: nodes.length,
      lastSyncedAt: now,
      lastError: null,
    });

    return {
      nodeCount: nodes.length,
      managerCount,
      discovered: plan.observations.filter((observation) => observation.discovered)
        .length,
      removed: plan.removed.length,
      health,
    };
  }

  async setMaintenance(
    remoteLocationId: string,
    enabled: boolean,
    actor: AuthenticatedUser,
  ) {
    const remoteLocation = await this.store.getRemoteLocation(remoteLocationId);
    if (!remoteLocation) {
      throw new NotFoundException("Remote Location not found");
    }
    if (remoteLocation.status === "Removed") {
      throw new ConflictException("Removed Remote Location cannot enter maintenance");
    }

    const availability = enabled ? "Drain" : "Active";
    const updatedInDocker = await this.docker.setNodeAvailability(
      remoteLocation.swarmNodeId,
      availability,
    );
    if (!updatedInDocker) {
      throw new ServiceUnavailableException(
        "Docker Swarm node availability update failed",
      );
    }

    const health = deriveRemoteLocationHealth(
      remoteLocation.status,
      availability,
    );
    const updated = await this.store.setRemoteLocationMaintenance(
      remoteLocationId,
      {
        maintenance: enabled,
        availability,
        health,
      },
    );

    await this.audit.recordMaintenance({
      remoteLocationId,
      swarmNodeId: remoteLocation.swarmNodeId,
      hostname: remoteLocation.hostname,
      enabled,
      actor,
    });

    return this.mapRemoteLocation(updated);
  }

  private async failReconcile(): Promise<never> {
    await Promise.allSettled([
      this.store.setClusterError("Docker Swarm inventory observation failed"),
      this.audit.recordReconcileFailed(),
    ]);
    throw new ServiceUnavailableException(
      "Docker Swarm inventory observation failed",
    );
  }

  private mapRemoteLocation(remoteLocation: RemoteLocationRow) {
    return {
      ...remoteLocation,
      cpuNano:
        typeof remoteLocation.cpuNano === "bigint"
          ? remoteLocation.cpuNano.toString()
          : String(remoteLocation.cpuNano ?? 0),
      memoryBytes:
        typeof remoteLocation.memoryBytes === "bigint"
          ? remoteLocation.memoryBytes.toString()
          : String(remoteLocation.memoryBytes ?? 0),
    };
  }
}
