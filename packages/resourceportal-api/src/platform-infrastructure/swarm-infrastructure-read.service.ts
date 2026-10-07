import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { HostMachineResourceUsageService } from "./host-machine-resource-usage.service";
import {
  SwarmInfrastructureStore,
  type RemoteLocationRow,
} from "./swarm-infrastructure.store";

@Injectable()
export class SwarmInfrastructureReadService {
  constructor(
    private readonly store: SwarmInfrastructureStore,
    private readonly prisma: PrismaService,
    private readonly hostUsage: HostMachineResourceUsageService,
  ) {}

  async getCluster() {
    const cluster = await this.store.getCluster();
    if (!cluster) {
      throw new NotFoundException("Swarm cluster has not been reconciled yet");
    }
    return cluster;
  }

  async listRemoteLocations() {
    return (await this.store.listRemoteLocations())
      .filter((item) => item.status !== "Removed")
      .map((item) => this.map(item));
  }

  async getRemoteLocation(id: string) {
    const item = await this.store.getRemoteLocation(id);
    if (!item || item.status === "Removed")
      throw new NotFoundException("Remote Location not found");
    return this.map(item);
  }

  async getResourceUsage() {
    const [locations, apps, backends, hostObservation] = await Promise.all([
      this.store.listRemoteLocations(),
      this.prisma.singleApp.findMany({
        where: { pendingDeletion: false, actualReplicas: { gt: 0 } },
        select: {
          gpu: true,
          actualReplicas: true,
        },
      }),
      this.prisma.storageBackend.findMany({
        select: { capacityTotal: true, capacityAvailable: true },
      }),
      this.hostUsage.observe().catch(() => null),
    ]);

    const activeLocations = locations.filter((item) => item.status !== "Removed");
    const configuredCpuTotalNano = activeLocations.reduce(
      (sum, item) => sum + item.cpuNano,
      0n,
    );
    const configuredMemoryTotalBytes = activeLocations.reduce(
      (sum, item) => sum + item.memoryBytes,
      0n,
    );
    const gpuTotal = activeLocations.reduce((sum, item) => sum + item.gpuCount, 0);
    const liveUsageAvailable =
      activeLocations.length === 1 && hostObservation !== null;

    const cpuTotalNano = liveUsageAvailable
      ? BigInt(hostObservation.cpuCount) * 1_000_000_000n
      : configuredCpuTotalNano;
    const memoryTotalBytes = liveUsageAvailable
      ? hostObservation.memoryTotalBytes
      : configuredMemoryTotalBytes;
    const cpuUsedNano = liveUsageAvailable
      ? BigInt(
          Math.round(Number(cpuTotalNano) * hostObservation.cpuUsedRatio),
        )
      : null;
    const memoryUsedBytes = liveUsageAvailable
      ? hostObservation.memoryUsedBytes
      : null;

    let gpuUsed = 0;
    for (const app of apps) {
      const replicas = Math.max(0, app.actualReplicas);
      gpuUsed += app.gpu * replicas;
    }

    const storageTotalBytes = backends.reduce(
      (sum, backend) => sum + (backend.capacityTotal ?? 0n),
      0n,
    );
    const storageAvailableBytes = backends.reduce(
      (sum, backend) => sum + (backend.capacityAvailable ?? 0n),
      0n,
    );
    const storageUsedBytes =
      storageTotalBytes > storageAvailableBytes
        ? storageTotalBytes - storageAvailableBytes
        : 0n;

    return {
      cpuUsedNano: cpuUsedNano?.toString() ?? null,
      cpuTotalNano: cpuTotalNano.toString(),
      memoryUsedBytes: memoryUsedBytes?.toString() ?? null,
      memoryTotalBytes: memoryTotalBytes.toString(),
      gpuUsed,
      gpuTotal,
      storageUsedBytes: storageUsedBytes.toString(),
      storageTotalBytes: storageTotalBytes.toString(),
      runningReplicas: apps.reduce((sum, app) => sum + app.actualReplicas, 0),
      liveUsageAvailable,
      liveUsageScope: liveUsageAvailable ? "host" : "unavailable",
      liveUsageReason: liveUsageAvailable
        ? null
        : activeLocations.length > 1
          ? "Live CPU and memory usage requires per-node telemetry for multi-node clusters."
          : "Live CPU and memory usage could not be read from the host.",
      observedAt: (hostObservation?.observedAt ?? new Date()).toISOString(),
    };
  }

  private map(remoteLocation: RemoteLocationRow) {
    return {
      ...remoteLocation,
      cpuNano: this.bigintString(remoteLocation.cpuNano),
      availableCpuNano: this.bigintString(remoteLocation.availableCpuNano),
      memoryBytes: this.bigintString(remoteLocation.memoryBytes),
      availableMemoryBytes: this.bigintString(remoteLocation.availableMemoryBytes),
    };
  }

  private bigintString(value: bigint) {
    return typeof value === "bigint" ? value.toString() : String(value ?? 0);
  }
}
