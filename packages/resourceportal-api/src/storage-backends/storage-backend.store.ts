import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { HealthState, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

export const DEFAULT_STORAGE_BACKEND_ID =
  "00000000-0000-4000-8000-000000000014";

const STORAGE_CAPACITY_LOCK_NAMESPACE = "resourceportal:storage-backend-capacity";

export type StorageBackendStatus = "Ready" | "Error";
export type StorageBackendType = "LocalFilesystem";

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

type ProjectIdRow = {
  projectId: bigint;
};

@Injectable()
export class StorageBackendStore {
  constructor(private readonly prisma: PrismaService) {}

  list(): Promise<StorageBackendRow[]> {
    return this.prisma.storageBackend.findMany({
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
  }

  get(id: string): Promise<StorageBackendRow | null> {
    return this.prisma.storageBackend.findUnique({ where: { id } });
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
    const backend = await tx.storageBackend.findUnique({
      where: { id: DEFAULT_STORAGE_BACKEND_ID },
    });
    if (!backend) throw new NotFoundException("Default StorageBackend not found");
    return backend;
  }

  async requireForVolume(volumeId: string) {
    const volume = await this.prisma.volume.findUnique({
      where: { id: volumeId },
      select: { storageBackend: true },
    });
    const backend = volume?.storageBackend;
    if (!backend) throw new NotFoundException("StorageBackend for Volume not found");
    return backend;
  }

  async requireForVolumeInTransaction(
    tx: Prisma.TransactionClient,
    volumeId: string,
  ) {
    const volume = await tx.volume.findUnique({
      where: { id: volumeId },
      select: { storageBackend: true },
    });
    const backend = volume?.storageBackend;
    if (!backend) throw new NotFoundException("StorageBackend for Volume not found");
    return backend;
  }

  async allocateProjectId(tx: Prisma.TransactionClient) {
    const rows = await tx.$queryRaw<ProjectIdRow[]>(Prisma.sql`
      SELECT nextval('"Volume_storageProjectId_seq"')::bigint AS "projectId"
    `);
    const raw = rows[0]?.projectId;
    if (raw === undefined) {
      throw new InternalServerErrorException("Unable to allocate storage project id");
    }

    const projectId = Number(raw);
    if (
      !Number.isSafeInteger(projectId) ||
      projectId <= 0 ||
      projectId > 2_147_483_647
    ) {
      throw new InternalServerErrorException("Allocated storage project id is invalid");
    }
    return projectId;
  }

  async requireProjectIdForVolume(volumeId: string) {
    const volume = await this.prisma.volume.findUnique({
      where: { id: volumeId },
      select: { storageProjectId: true },
    });
    const raw = volume?.storageProjectId;
    if (raw === undefined || raw === null) {
      throw new NotFoundException("Storage project id for Volume not found");
    }
    return this.projectIdNumber(BigInt(raw));
  }

  async requireProjectIdForVolumeInTransaction(
    tx: Prisma.TransactionClient,
    volumeId: string,
  ) {
    const volume = await tx.volume.findUnique({
      where: { id: volumeId },
      select: { storageProjectId: true },
    });
    const raw = volume?.storageProjectId;
    if (raw === undefined || raw === null) {
      throw new NotFoundException("Storage project id for Volume not found");
    }
    return this.projectIdNumber(BigInt(raw));
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

  async usedCapacity(backendId: string) {
    const aggregate = await this.prisma.volume.aggregate({
      where: { storageBackendId: backendId },
      _sum: { usedSizeBytes: true },
    });
    return aggregate._sum.usedSizeBytes ?? 0n;
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
    await this.prisma.volume.updateMany({
      where: { id: volumeId },
      data: {
        sizeBytes,
        pendingSizeBytes: null,
        status: "Ready",
        updatedBy: actorId,
      },
    });
  }

  async failResize(volumeId: string, actorId: string) {
    await this.prisma.volume.updateMany({
      where: { id: volumeId },
      data: {
        pendingSizeBytes: null,
        status: "Error",
        updatedBy: actorId,
      },
    });
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
    const updated = await this.prisma.storageBackend.updateMany({
      where: { id },
      data: input,
    });
    if (updated.count !== 1) throw new NotFoundException("StorageBackend not found");
    return this.require(id);
  }

  async setMaintenance(id: string, maintenance: boolean) {
    const updated = await this.prisma.storageBackend.updateMany({
      where: { id },
      data: { maintenance },
    });
    if (updated.count !== 1) throw new NotFoundException("StorageBackend not found");
    return this.require(id);
  }

  private projectIdNumber(raw: bigint) {
    const projectId = Number(raw);
    if (
      !Number.isSafeInteger(projectId) ||
      projectId <= 0 ||
      projectId > 2_147_483_647
    ) {
      throw new InternalServerErrorException("Storage project id is invalid");
    }
    return projectId;
  }
}
