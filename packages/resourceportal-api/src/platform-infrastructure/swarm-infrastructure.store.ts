import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import {
  InfrastructureHealth,
  RemoteLocationAvailability,
  RemoteLocationRole,
  RemoteLocationStatus,
} from "./swarm-infrastructure.logic";

export const SWARM_CLUSTER_SINGLETON_ID =
  "00000000-0000-0000-0000-000000000013";

type SwarmClusterRow = {
  id: string;
  dockerClusterId: string;
  health: InfrastructureHealth;
  managerCount: number;
  nodeCount: number;
  lastSyncedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type RemoteLocationRow = {
  id: string;
  swarmNodeId: string;
  hostname: string;
  role: RemoteLocationRole;
  status: RemoteLocationStatus;
  availability: RemoteLocationAvailability;
  health: InfrastructureHealth;
  maintenance: boolean;
  cpuNano: bigint;
  availableCpuNano: bigint;
  memoryBytes: bigint;
  availableMemoryBytes: bigint;
  gpuCount: number;
  networkCapabilities: string[];
  lastSeenAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class SwarmInfrastructureStore {
  constructor(private readonly prisma: PrismaService) {}

  async getCluster(): Promise<SwarmClusterRow | null> {
    const row = await this.prisma.swarmCluster.findUnique({
      where: { id: SWARM_CLUSTER_SINGLETON_ID },
    });
    return row ? this.mapCluster(row) : null;
  }

  async listRemoteLocations(): Promise<RemoteLocationRow[]> {
    const rows = await this.prisma.remoteLocation.findMany({
      orderBy: [{ hostname: "asc" }, { id: "asc" }],
    });
    return rows.map((row) => this.mapRemoteLocation(row));
  }

  async getRemoteLocation(id: string): Promise<RemoteLocationRow | null> {
    const row = await this.prisma.remoteLocation.findUnique({ where: { id } });
    return row ? this.mapRemoteLocation(row) : null;
  }

  async requireRemoteLocation(id: string) {
    const remoteLocation = await this.getRemoteLocation(id);
    if (!remoteLocation) {
      throw new NotFoundException("Remote Location not found");
    }
    return remoteLocation;
  }

  async upsertRemoteLocation(input: {
    id: string;
    swarmNodeId: string;
    hostname: string;
    role: RemoteLocationRole;
    status: RemoteLocationStatus;
    availability: RemoteLocationAvailability;
    health: InfrastructureHealth;
    maintenance: boolean;
    cpuNano: bigint;
    availableCpuNano: bigint;
    memoryBytes: bigint;
    availableMemoryBytes: bigint;
    gpuCount: number;
    networkCapabilities: string[];
    lastSeenAt: Date;
  }) {
    const row = await this.prisma.remoteLocation.upsert({
      where: { swarmNodeId: input.swarmNodeId },
      create: input,
      update: {
        hostname: input.hostname,
        role: input.role,
        status: input.status,
        availability: input.availability,
        health: input.health,
        maintenance: input.maintenance,
        cpuNano: input.cpuNano,
        availableCpuNano: input.availableCpuNano,
        memoryBytes: input.memoryBytes,
        availableMemoryBytes: input.availableMemoryBytes,
        gpuCount: input.gpuCount,
        networkCapabilities: input.networkCapabilities,
        lastSeenAt: input.lastSeenAt,
      },
    });
    return this.mapRemoteLocation(row);
  }

  async markRemoteLocationRemoved(id: string) {
    await this.prisma.remoteLocation.updateMany({
      where: { id },
      data: {
        status: "Removed",
        health: "Unhealthy",
        maintenance: false,
        availableCpuNano: 0n,
        availableMemoryBytes: 0n,
      },
    });
  }

  async saveCluster(input: {
    dockerClusterId: string;
    health: InfrastructureHealth;
    managerCount: number;
    nodeCount: number;
    lastSyncedAt: Date;
    lastError: string | null;
  }) {
    const row = await this.prisma.swarmCluster.upsert({
      where: { id: SWARM_CLUSTER_SINGLETON_ID },
      create: {
        id: SWARM_CLUSTER_SINGLETON_ID,
        ...input,
      },
      update: input,
    });
    return this.mapCluster(row);
  }

  async setClusterError(error: string) {
    await this.prisma.swarmCluster.updateMany({
      where: { id: SWARM_CLUSTER_SINGLETON_ID },
      data: { health: "Unknown", lastError: error },
    });
  }

  async setRemoteLocationMaintenance(
    id: string,
    input: {
      maintenance: boolean;
      availability: RemoteLocationAvailability;
      health: InfrastructureHealth;
      availableCpuNano: bigint;
      availableMemoryBytes: bigint;
    },
  ) {
    const updated = await this.prisma.remoteLocation.updateMany({
      where: { id },
      data: input,
    });
    if (updated.count !== 1) {
      throw new NotFoundException("Remote Location not found");
    }
    const row = await this.prisma.remoteLocation.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException("Remote Location not found");
    }
    return this.mapRemoteLocation(row);
  }

  private mapCluster(row: {
    id: string;
    dockerClusterId: string;
    health: string;
    managerCount: number;
    nodeCount: number;
    lastSyncedAt: Date | null;
    lastError: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): SwarmClusterRow {
    return { ...row, health: row.health as InfrastructureHealth };
  }

  private mapRemoteLocation(row: {
    id: string;
    swarmNodeId: string;
    hostname: string;
    role: string;
    status: string;
    availability: string;
    health: string;
    maintenance: boolean;
    cpuNano: bigint;
    availableCpuNano: bigint;
    memoryBytes: bigint;
    availableMemoryBytes: bigint;
    gpuCount: number;
    networkCapabilities: string[];
    lastSeenAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }): RemoteLocationRow {
    return {
      ...row,
      role: row.role as RemoteLocationRole,
      status: row.status as RemoteLocationStatus,
      availability: row.availability as RemoteLocationAvailability,
      health: row.health as InfrastructureHealth,
    };
  }
}
