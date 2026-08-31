import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { HealthState, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

export const DEFAULT_STORAGE_BACKEND_ID =
  "00000000-0000-4000-8000-000000000014";

const STORAGE_CAPACITY_LOCK_NAMESPACE = "resourceportal:storage-backend-capacity";

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

type CommittedCapacityRow = {
  committedBytes: bigint;
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

  async requireDefaultInTransaction(tx: Prisma.TransactionClient) {
    const rows = await tx.$queryRaw<StorageBackendRow[]>(Prisma.sql`
      SELECT * FROM "StorageBackend"
      WHERE "id" = ${DEFAULT_STORAGE_BACKEND_ID}::uuid
      LIMIT 1
    `);
    const backend = rows[0];
    if (!backend) throw new NotFoundException("Default StorageBackend not found");
    return backend;
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

  async requireForVolumeInTransaction(
    tx: Prisma.TransactionClient,
    volumeId: string,
  ) {
    const rows = await tx.$queryRaw<StorageBackendRow[]>(Prisma.sql`
      SELECT sb.*
      FROM "StorageBackend" sb
      INNER JOIN "Volume" v ON v."storageBackendId" = sb."id"
      WHERE v."id" = ${volumeId}::uuid
      LIMIT 1
    `);
    const backend = rows[0];
    if (!backend) throw new NotFoundException("StorageBackend for Volume not found");
    return backend;
  }

  async lockCapacity(
    tx: Prisma.TransactionClient,
    backendId: string = DEFAULT_STORAGE_BACKEND_ID,
  ) {
    await tx.$queryRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${STORAGE_CAPACITY_LOCK_NAMESPACE}:${backendId}`}, 0)) IS NULL AS "locked"`,
    );
  }

  async committedCapacity(
    tx: Prisma.TransactionClient,
    backendId: string,
    excludeVolumeId?: string,
  ) {
    const exclusion = excludeVolumeId
      ? Prisma.sql`AND "id" <> ${excludeVolumeId}::uuid`
      : Prisma.empty;
    const rows = await tx.$queryRaw<CommittedCapacityRow[]>(Prisma.sql`
      SELECT COALESCE(SUM(COALESCE("pendingSizeBytes", "sizeBytes")), 0)::bigint AS "committedBytes"
      FROM "Volume"
      WHERE "storageBackendId" = ${backendId}::uuid
      ${exclusion}
    `);
    return rows[0]?.committedBytes ?? 0n;
  }

  async reserveResize(
    tx: Prisma.TransactionClient,
    input: {
      volumeId: string;
      pendingSizeBytes: bigint;
      actorId: string;
    },
  ) {
    const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      UPDATE "Volume"
      SET
        "pendingSizeBytes" = ${input.pendingSizeBytes},
        "status" = 'Resizing',
        "updatedBy" = ${input.actorId},
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${input.volumeId}::uuid
        AND "pendingSizeBytes" IS NULL
        AND "status" NOT IN ('Creating', 'Deleting')
      RETURNING "id"
    `);
    if (!rows[0]) {
      throw new ConflictException("Volume resize already in progress");
    }
  }

  async completeResize(
    volumeId: string,
    sizeBytes: bigint,
    actorId: string,
  ) {
    await this.prisma.$executeRaw`
      UPDATE "Volume"
      SET
        "sizeBytes" = ${sizeBytes},
        "pendingSizeBytes" = NULL,
        "status" = 'Ready',
        "updatedBy" = ${actorId},
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${volumeId}::uuid
    `;
  }

  async failResize(volumeId: string, actorId: string) {
    await this.prisma.$executeRaw`
      UPDATE "Volume"
      SET
        "pendingSizeBytes" = NULL,
        "status" = 'Error',
        "updatedBy" = ${actorId},
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${volumeId}::uuid
    `;
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
        "status" = ${input.status}::"StorageBackendStatus",
        "health" = ${input.health}::"HealthState",
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
