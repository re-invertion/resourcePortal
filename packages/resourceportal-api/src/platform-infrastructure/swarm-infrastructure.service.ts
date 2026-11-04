import {
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { NvidiaGpuAllocationService } from "./nvidia-gpu-allocation.service";
import { SwarmGpuNodeProbeRouter } from "./swarm-gpu-node-probe-router";
import { AuthenticatedUser } from "../auth/types";
import { ObservabilityService } from "../observability/observability.service";
import { DockerSwarmInfrastructureService } from "./docker-swarm-infrastructure.service";
import { SwarmInfrastructureAuditService } from "./swarm-infrastructure-audit.service";
import {
  deriveRemoteLocationHealth,
  deriveSchedulableCapacity,
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
    @Optional() private readonly observability?: ObservabilityService,
    @Optional() private readonly gpuProbe?: SwarmGpuNodeProbeRouter,
    @Optional() private readonly gpuAllocation?: NvidiaGpuAllocationService,
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
    const probeReports = await this.gpuProbe?.collect() ?? [];
    const reportsByNode = new Map(probeReports.map((report) => [report.swarmNodeId, report]));

    for (const node of nodes) {
      const observation = observationByNodeId.get(node.swarmNodeId);
      if (!observation) {
        continue;
      }

      const current = existingByNodeId.get(node.swarmNodeId);
      const capabilities = parseNodeCapabilities(node.labels);
      const capacity = deriveSchedulableCapacity(
        node.status,
        node.availability,
        node.cpuNano,
        node.memoryBytes,
      );
      const report = reportsByNode.get(node.swarmNodeId);
      const advertised = node.gpuUuids ?? [];
      const advertisedUuids = new Set(advertised.map((uuid) => uuid.toLowerCase()));
      const verified =
        report?.status === "Observed" &&
        advertised.length === report.devices.length &&
        report.devices.every((device) => advertisedUuids.has(device.uuid.toLowerCase())) &&
        node.status === "Ready" && node.availability === "Active";
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
        availableCpuNano: capacity.availableCpuNano,
        memoryBytes: node.memoryBytes,
        availableMemoryBytes: capacity.availableMemoryBytes,
        gpuCount: verified ? advertised.length : 0,
        networkCapabilities: capabilities.networkCapabilities,
        lastSeenAt: now,
      });

      // Unknown or failed probes invalidate availability, never ownership.
      // A Swarm label alone does not authorize GPU scheduling.
      if (this.gpuAllocation) {
        if (!verified) {
          await this.gpuAllocation.markNodeUnavailable(id);
        } else {
          for (const device of report.devices) {
            await this.gpuAllocation.observe(id, device, true);
          }
        }
      }

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
      await this.store.removeRemoteLocation(removed.id);
      this.observability?.removeRemoteLocationSnapshot(removed.id);
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

    await this.publishRemoteLocationMetrics();

    return {
      nodeCount: nodes.length,
      managerCount,
      discovered: plan.observations.filter((observation) => observation.discovered)
        .length,
      removed: plan.removed.length,
      health,
    };
  }

  /**
   * Live, evidence-based explanation of a stale GPU. This is executed by the
   * infrastructure Worker; API controllers never call Docker directly.
   */
  async diagnoseGpu(gpuUuid: string) {
    if (!/^GPU-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(gpuUuid)) {
      throw new ConflictException("InvalidGpuUuid");
    }
    if (!this.gpuAllocation || !this.gpuProbe) {
      throw new ServiceUnavailableException("GpuVerificationUnavailable");
    }
    const inventory = await this.gpuAllocation.listInventory();
    const device = inventory.find((gpu) => gpu.uuid.toLowerCase() === gpuUuid.toLowerCase());
    if (!device) throw new NotFoundException("GpuNotFound");
    const [nodes, reports] = await Promise.all([
      this.docker.listNodes(), this.gpuProbe.collect(),
    ]);
    const nodeId = device.node?.swarmNodeId;
    const node = nodes?.find((item) => item.swarmNodeId === nodeId);
    const report = reports.find((item) => item.swarmNodeId === nodeId);
    const reasons: string[] = [];
    if (!nodes) reasons.push("SwarmNodeInventoryUnavailable");
    else if (!node) reasons.push("GpuSwarmNodeMissing");
    else {
      if (node.status !== "Ready" || node.availability !== "Active") {
        reasons.push("GpuNodeNotSchedulable");
      }
      if (!(node.gpuUuids ?? []).some((uuid) =>
        uuid.toLowerCase() === gpuUuid.toLowerCase())) {
        reasons.push("NvidiaNamedGenericResourceMissing");
      }
    }
    if (!report) reasons.push("GpuProbeReportMissing");
    else if (report.status !== "Observed") reasons.push(report.reason);
    else if (!report.devices.some((gpu) =>
      gpu.uuid.toLowerCase() === gpuUuid.toLowerCase())) reasons.push("GpuProbeUuidMismatch");
    else if (node && report.devices.length !== (node.gpuUuids ?? []).length) {
      reasons.push("GpuProbeGenericResourceCountMismatch");
    } else if (node && report.devices.some((gpu) =>
      !(node.gpuUuids ?? []).some((uuid) => uuid.toLowerCase() === gpu.uuid.toLowerCase()))) {
      reasons.push("GpuProbeGenericResourceUuidMismatch");
    }
    if (device.observedState !== "Available") reasons.push("GpuObservationUnavailable");
    if (node && device.node &&
        node.swarmNodeId !== device.node.swarmNodeId) reasons.push("GpuNodeIdentityMismatch");
    return {
      uuid: device.uuid, observedState: device.observedState,
      allocationState: device.allocationState,
      allocatedSingleAppId: device.allocatedSingleAppId,
      nodeId: nodeId ?? null,
      gpuCount: node?.gpuUuids?.length ?? 0,
      reasonCodes: [...new Set(reasons)],
      verified: reasons.length === 0,
    };
  }

  /**
   * Admin-only recovery operation. A fresh successful probe restores a
   * same-owner assignment without changing its UUID or tenant. Releasing an
   * unavailable card requires an explicit operator flag and POSITIVE proof
   * that the entire Swarm has no runnable GPU services and every authenticated
   * node reports zero GPU containers. Unknown evidence blocks release.
   */
  async recoverGpu(
    gpuUuid: string, actor: AuthenticatedUser, releaseIfUnavailable = false,
  ) {
    if (!this.gpuAllocation || !this.gpuProbe) {
      throw new ServiceUnavailableException("GpuRecoveryUnavailable");
    }
    await this.reconcile();
    const diagnosis = await this.diagnoseGpu(gpuUuid);
    if (diagnosis.verified) {
      return { status: "ReadyForRedeploy", diagnosis, ownershipPreserved: true };
    }
    if (!releaseIfUnavailable) {
      return { status: "VerificationFailed", diagnosis, ownershipPreserved: true };
    }
    if (!diagnosis.allocatedSingleAppId) {
      return { status: "NotAllocated", diagnosis, ownershipPreserved: true };
    }
    // No runtime probe, stale agent or missing node can prove workload absence.
    const nodes = await this.docker.listNodes();
    if (!nodes?.length || nodes.length > 128 ||
        nodes.some((node) => node.status !== "Ready" || node.availability !== "Active")) {
      throw new ConflictException("GpuAllNodesMustBeVerifiedForRelease");
    }
    const reports = await this.gpuProbe.collectUsage();
    if (reports.length !== nodes.length ||
        nodes.some((node) => {
          const matches = reports.filter((report) => report.swarmNodeId === node.swarmNodeId);
          if (matches.length !== 1) return true;
          const report = matches[0];
          return report.status !== "Verified" || report.busyAnyGpu ||
            report.containers.some((container) =>
              container.uuid.toLowerCase() === gpuUuid.toLowerCase());
        })) {
      throw new ConflictException("GpuContainerCleanupNotVerified");
    }
    if (!await this.docker.verifyNoGpuSwarmServiceReservations()) {
      throw new ConflictException("GpuSwarmServiceStillReservesGpu");
    }
    const released = await this.gpuAllocation.adminReleaseStaleGpu(
      diagnosis.uuid, true, actor,
    );
    return { status: released.released ? "StaleAllocationReleased" : "AlreadyReleased",
      diagnosis, released };
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
    const capacity = deriveSchedulableCapacity(
      remoteLocation.status,
      availability,
      remoteLocation.cpuNano,
      remoteLocation.memoryBytes,
    );
    const updated = await this.store.setRemoteLocationMaintenance(
      remoteLocationId,
      {
        maintenance: enabled,
        availability,
        health,
        availableCpuNano: capacity.availableCpuNano,
        availableMemoryBytes: capacity.availableMemoryBytes,
      },
    );

    await this.audit.recordMaintenance({
      remoteLocationId,
      swarmNodeId: remoteLocation.swarmNodeId,
      hostname: remoteLocation.hostname,
      enabled,
      actor,
    });

    this.publishRemoteLocationMetric(updated);
    return this.mapRemoteLocation(updated);
  }

  private async publishRemoteLocationMetrics() {
    if (!this.observability) {
      return;
    }
    const remoteLocations = await this.store.listRemoteLocations();
    for (const remoteLocation of remoteLocations) {
      this.publishRemoteLocationMetric(remoteLocation);
    }
  }

  private publishRemoteLocationMetric(remoteLocation: RemoteLocationRow) {
    this.observability?.recordRemoteLocationSnapshot({
      id: remoteLocation.id,
      hostname: remoteLocation.hostname,
      status: remoteLocation.status,
      health: remoteLocation.health,
      maintenance: remoteLocation.maintenance,
      cpuNano: remoteLocation.cpuNano,
      availableCpuNano: remoteLocation.availableCpuNano,
      memoryBytes: remoteLocation.memoryBytes,
      availableMemoryBytes: remoteLocation.availableMemoryBytes,
    });
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
      cpuNano: this.bigintString(remoteLocation.cpuNano),
      availableCpuNano: this.bigintString(remoteLocation.availableCpuNano),
      memoryBytes: this.bigintString(remoteLocation.memoryBytes),
      availableMemoryBytes: this.bigintString(
        remoteLocation.availableMemoryBytes,
      ),
    };
  }

  private bigintString(value: bigint) {
    return typeof value === "bigint" ? value.toString() : String(value ?? 0);
  }
}
