import { Injectable, NotFoundException } from "@nestjs/common";
import { HealthState } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

export const DEFAULT_STORAGE_BACKEND_ID =
  "00000000-0000-4000-8000-000000000014";

export type StorageBackendStatus = "Ready" | "Error";
export type StorageBackendType = "CephFS";

export type StorageBackendRow = {
  id: string;
  name: string;
  type: StorageBackendType;
  basePath: string;
  volumeBasePath: string;
  secretBasePath: string;
  status: StorageBackendStatus;
  health: HealthState;
  maintenance: boolean;
  capacityTotal: bigint | null;
  capacityAvailable: bigint | null;
  lastValidatedAt: Date | null;
  lastValidationError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class StorageBackendStore {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.$queryRaw<StorageBackendRow[]>`
      SELECT * FROM "StorageBackend"
      ORDER BY "name" ASC, "id" ASC
    `;
  }

  async get(id: string) {
    const rows = await this.prisma.$queryRaw<StorageBackendRow[]>`
      SELECT * FROM "StorageBackend"
      WHERE "id" = ${id}::uuid
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async require(id: string) {
    const backend = await this.get(id);
    if (!backend) throw new NotFoundException("StorageBackend not found");
    return backend;
  }

  requireDefault() {
    return this.require(DEFAULT_STORAGE_BACKEND_ID);
  }

  async requireForVolume(volumeId: string) {
    const rows = await this.prisma.$queryRaw<StorageBackendRow[]>`
      SELECT sb.*
      FROM "StorageBackend" sb
      INNER JOIN "Volume" v ON v."storageBackendId" = sb."id"
      WHERE v."id" = ${volumeId}::uuid
      LIMIT 1
    `;
    const backend = rows[0];
    if (!backend) throw new NotFoundException("StorageBackend for Volume not found");
    return backend;
  }

  async saveValidation(
    id: string,
    input: {
      status: StorageBackendStatus;
      health: HealthState;
      capacityTotal: bigint | null;
      capacityAvailable: bigint | null;
      lastValidatedAt: Date;
      lastValidationError: string | null;
    },
  ) {
    const rows = await this.prisma.$queryRaw<StorageBackendRow[]>`
      UPDATE "StorageBackend"
      SET
        "status" = ${input.status},
        "health" = ${input.health},
        "capacityTotal" = ${input.capacityTotal},
        "capacityAvailable" = ${input.capacityAvailable},
        "lastValidatedAt" = ${input.lastValidatedAt},
        "lastValidationError" = ${input.lastValidationError},
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${id}::uuid
      RETURNING *
    `;
    const backend = rows[0];
    if (!backend) throw new NotFoundException("StorageBackend not found");
    return backend;
  }

  async setMaintenance(id: string, maintenance: boolean) {
    const rows = await this.prisma.$queryRaw<StorageBackendRow[]>`
      UPDATE "StorageBackend"
      SET "maintenance" = ${maintenance}, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${id}::uuid
      RETURNING *
    `;
    const backend = rows[0];
    if (!backend) throw new NotFoundException("StorageBackend not found");
    return backend;
  }
}
