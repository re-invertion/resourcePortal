import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
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
  memoryBytes: bigint;
  gpuCount: number;
  networkCapabilities: string[];
  lastSeenAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class SwarmInfrastructureStore {
  constructor(private readonly prisma: PrismaService) {}

  async getCluster() {
    const rows = await this.prisma.$queryRaw<SwarmClusterRow[]>`
      SELECT * FROM "SwarmCluster"
      WHERE "id" = ${SWARM_CLUSTER_SINGLETON_ID}::uuid
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async listRemoteLocations() {
    return this.prisma.$queryRaw<RemoteLocationRow[]>`
      SELECT * FROM "RemoteLocation"
      ORDER BY "hostname" ASC, "id" ASC
    `;
  }

  async getRemoteLocation(id: string) {
    const rows = await this.prisma.$queryRaw<RemoteLocationRow[]>`
      SELECT * FROM "RemoteLocation"
      WHERE "id" = ${id}::uuid
      LIMIT 1
    `;
    return rows[0] ?? null;
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
    memoryBytes: bigint;
    gpuCount: number;
    networkCapabilities: string[];
    lastSeenAt: Date;
  }) {
    const networkCapabilities =
      input.networkCapabilities.length > 0
        ? Prisma.sql`ARRAY[${Prisma.join(input.networkCapabilities)}]::TEXT[]`
        : Prisma.sql`ARRAY[]::TEXT[]`;

    await this.prisma.$executeRaw`
      INSERT INTO "RemoteLocation" (
        "id", "swarmNodeId", "hostname", "role", "status", "availability",
        "health", "maintenance", "cpuNano", "memoryBytes", "gpuCount",
        "networkCapabilities", "lastSeenAt", "createdAt", "updatedAt"
      ) VALUES (
        ${input.id}::uuid,
        ${input.swarmNodeId},
        ${input.hostname},
        ${input.role},
        ${input.status},
        ${input.availability},
        ${input.health},
        ${input.maintenance},
        ${input.cpuNano},
        ${input.memoryBytes},
        ${input.gpuCount},
        ${networkCapabilities},
        ${input.lastSeenAt},
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT ("swarmNodeId") DO UPDATE SET
        "hostname" = EXCLUDED."hostname",
        "role" = EXCLUDED."role",
        "status" = EXCLUDED."status",
        "availability" = EXCLUDED."availability",
        "health" = EXCLUDED."health",
        "maintenance" = EXCLUDED."maintenance",
        "cpuNano" = EXCLUDED."cpuNano",
        "memoryBytes" = EXCLUDED."memoryBytes",
        "gpuCount" = EXCLUDED."gpuCount",
        "networkCapabilities" = EXCLUDED."networkCapabilities",
        "lastSeenAt" = EXCLUDED."lastSeenAt",
        "updatedAt" = CURRENT_TIMESTAMP
    `;
  }

  async markRemoteLocationRemoved(id: string) {
    await this.prisma.$executeRaw`
      UPDATE "RemoteLocation"
      SET
        "status" = 'Removed',
        "health" = 'Unhealthy',
        "maintenance" = false,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${id}::uuid
    `;
  }

  async saveCluster(input: {
    dockerClusterId: string;
    health: InfrastructureHealth;
    managerCount: number;
    nodeCount: number;
    lastSyncedAt: Date;
    lastError: string | null;
  }) {
    await this.prisma.$executeRaw`
      INSERT INTO "SwarmCluster" (
        "id", "dockerClusterId", "health", "managerCount", "nodeCount",
        "lastSyncedAt", "lastError", "createdAt", "updatedAt"
      ) VALUES (
        ${SWARM_CLUSTER_SINGLETON_ID}::uuid,
        ${input.dockerClusterId},
        ${input.health},
        ${input.managerCount},
        ${input.nodeCount},
        ${input.lastSyncedAt},
        ${input.lastError},
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT ("id") DO UPDATE SET
        "dockerClusterId" = EXCLUDED."dockerClusterId",
        "health" = EXCLUDED."health",
        "managerCount" = EXCLUDED."managerCount",
        "nodeCount" = EXCLUDED."nodeCount",
        "lastSyncedAt" = EXCLUDED."lastSyncedAt",
        "lastError" = EXCLUDED."lastError",
        "updatedAt" = CURRENT_TIMESTAMP
    `;
  }

  async setClusterError(error: string) {
    await this.prisma.$executeRaw`
      UPDATE "SwarmCluster"
      SET "health" = 'Unknown', "lastError" = ${error}, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${SWARM_CLUSTER_SINGLETON_ID}::uuid
    `;
  }

  async setRemoteLocationMaintenance(
    id: string,
    input: {
      maintenance: boolean;
      availability: RemoteLocationAvailability;
      health: InfrastructureHealth;
    },
  ) {
    const rows = await this.prisma.$queryRaw<RemoteLocationRow[]>`
      UPDATE "RemoteLocation"
      SET
        "maintenance" = ${input.maintenance},
        "availability" = ${input.availability},
        "health" = ${input.health},
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${id}::uuid
      RETURNING *
    `;

    const remoteLocation = rows[0];
    if (!remoteLocation) {
      throw new NotFoundException("Remote Location not found");
    }
    return remoteLocation;
  }
}
