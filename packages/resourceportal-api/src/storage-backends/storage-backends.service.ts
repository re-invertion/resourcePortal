import {
  ConflictException,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { HealthState, Prisma } from "@prisma/client";
import { posix } from "node:path";
import { AuthenticatedUser } from "../auth/types";
import {
  insufficientCapacityException,
  platformUnavailableException,
} from "../capacity/capacity-errors";
import { ObservabilityService } from "../observability/observability.service";
import {
  LocalFilesystemBackendDescriptor,
  LocalFilesystemStorageAdapterService,
} from "./local-filesystem-storage-adapter.service";
import { NfsRemoteAccessValidatorService } from "./nfs-remote-access-validator.service";
import { StorageBackendRow, StorageBackendStore } from "./storage-backend.store";

export type StorageBackendReservation = {
  backend: StorageBackendRow;
  storagePath: string;
  projectId: number;
};

@Injectable()
export class StorageBackendsService {
  constructor(
    private readonly store: StorageBackendStore,
    private readonly localFilesystem: LocalFilesystemStorageAdapterService,
    private readonly remoteAccess: NfsRemoteAccessValidatorService,
    @Optional() private readonly observability?: ObservabilityService,
  ) {}

  async listBackends() {
    const backends = await this.store.list();
    await Promise.all(backends.map((backend) => this.publishBackendMetric(backend)));
    return backends.map((backend) => this.mapBackend(backend));
  }

  async getBackend(id: string) {
    const backend = await this.store.require(id);
    await this.publishBackendMetric(backend);
    return this.mapBackend(backend);
  }

  async validateBackend(id: string) {
    const backend = await this.store.require(id);
    const now = new Date();

    try {
      const local = await this.localFilesystem.validateLocal();
      const remote = await this.remoteAccess.validate(backend.basePath);
      const healthReady = this.isWritableHealth(local.health);
      const ready = healthReady && remote.ok;
      const error = remote.error;
      const saved = await this.store.saveValidation(id, {
        status: ready ? "Ready" : "Error",
        health: local.health,
        capacityTotal: local.capacityTotal,
        capacityAvailable: local.capacityAvailable,
        lastValidatedAt: now,
        lastValidationError: ready && !remote.skipped ? null : error,
      });
      await this.publishBackendMetric(saved);
      return this.mapBackend(saved);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "StorageBackend validation failed";
      const saved = await this.store.saveValidation(id, {
        status: "Error",
        health: HealthState.Unknown,
        capacityTotal: null,
        capacityAvailable: null,
        lastValidatedAt: now,
        lastValidationError: message,
      });
      await this.publishBackendMetric(saved);
      return this.mapBackend(saved);
    }
  }

  async validateDefaultBackend() {
    const backend = await this.store.requireDefault();
    return this.validateBackend(backend.id);
  }

  async setMaintenance(
    id: string,
    enabled: boolean,
    actor: AuthenticatedUser,
  ) {
    void actor;
    const backend = await this.store.setMaintenance(id, enabled);
    await this.publishBackendMetric(backend);
    return this.mapBackend(backend);
  }

  async refreshDefaultBackendForWrite() {
    return this.refreshBackendForWrite(await this.store.requireDefault());
  }

  async refreshVolumeBackendForWrite(volumeId: string) {
    return this.refreshBackendForWrite(
      await this.store.requireForVolume(volumeId),
    );
  }

  async reserveVolume(
    tx: Prisma.TransactionClient,
    input: { tenantId: string; volumeId: string; sizeBytes: bigint },
  ): Promise<StorageBackendReservation> {
    await this.store.lockCapacity(tx);
    const backend = await this.store.requireDefaultInTransaction(tx);
    this.assertPersistedWritable(backend);

    const committed = await this.store.committedCapacity(tx, backend.id);
    this.assertCapacity(backend, committed, input.sizeBytes, input.sizeBytes);
    const projectId = await this.store.allocateProjectId(tx);

    return {
      backend,
      storagePath: posix.join(
        backend.volumeBasePath,
        input.tenantId,
        input.volumeId,
      ),
      projectId,
    };
  }

  async provisionVolume(
    reservation: StorageBackendReservation,
    input: { tenantId: string; volumeId: string; sizeBytes: bigint },
  ) {
    const result = await this.localFilesystem.provisionVolume(
      reservation.backend,
      {
        ...input,
        projectId: reservation.projectId,
      },
    );
    if (result.storagePath !== reservation.storagePath) {
      throw new ServiceUnavailableException(
        "StorageBackend returned an unexpected Volume path",
      );
    }
  }

  async cleanupProvisionedVolume(
    backend: LocalFilesystemBackendDescriptor,
    storagePath: string,
  ) {
    await this.localFilesystem.deleteVolume(backend, storagePath);
  }

  async reserveResize(
    tx: Prisma.TransactionClient,
    input: {
      volumeId: string;
      storagePath: string;
      requestedSizeBytes: bigint;
      currentSizeBytes: bigint;
      actorId: string;
    },
  ): Promise<StorageBackendReservation> {
    const growth = input.requestedSizeBytes - input.currentSizeBytes;
    if (growth < 0n) {
      throw new ConflictException("Volume cannot be shrunk");
    }

    await this.store.lockCapacity(tx);
    const backend = await this.store.requireForVolumeInTransaction(
      tx,
      input.volumeId,
    );
    this.assertPersistedWritable(backend);

    const committed = await this.store.committedCapacity(
      tx,
      backend.id,
      input.volumeId,
    );
    this.assertCapacity(backend, committed, input.requestedSizeBytes, growth);
    const projectId = await this.store.requireProjectIdForVolumeInTransaction(
      tx,
      input.volumeId,
    );
    await this.store.reserveResize(tx, {
      volumeId: input.volumeId,
      pendingSizeBytes: input.requestedSizeBytes,
      actorId: input.actorId,
    });

    return { backend, storagePath: input.storagePath, projectId };
  }

  async resizeVolume(
    reservation: StorageBackendReservation,
    input: { storagePath: string; requestedSizeBytes: bigint },
  ) {
    await this.localFilesystem.resizeVolume(
      reservation.backend,
      input.storagePath,
      input.requestedSizeBytes,
      reservation.projectId,
    );
  }

  completeResize(volumeId: string, sizeBytes: bigint, actorId: string) {
    return this.store.completeResize(volumeId, sizeBytes, actorId);
  }

  failResize(volumeId: string, actorId: string) {
    return this.store.failResize(volumeId, actorId);
  }

  async deleteVolume(volumeId: string, storagePath: string) {
    const backend = await this.store.requireForVolume(volumeId);
    await this.localFilesystem.deleteVolume(backend, storagePath);
  }

  async measureUsedSize(volumeId: string, storagePath: string) {
    const backend = await this.store.requireForVolume(volumeId);
    const usedSize = await this.localFilesystem.measureUsedSize(
      backend,
      storagePath,
    );
    await this.publishBackendMetric(backend);
    return usedSize;
  }

  runtimeVolumeDefinition(storagePath: string) {
    return {
      driver: "local" as const,
      driver_opts: this.localFilesystem.runtimeDriverOptions(storagePath),
    };
  }

  private async refreshBackendForWrite(backend: StorageBackendRow) {
    this.assertPersistedWritable(backend);
    const live = await this.localFilesystem.validateLocal();
    const healthy = this.isWritableHealth(live.health);
    const saved = await this.store.saveValidation(backend.id, {
      status: healthy ? "Ready" : "Error",
      health: live.health,
      capacityTotal: live.capacityTotal,
      capacityAvailable: live.capacityAvailable,
      lastValidatedAt: new Date(),
      lastValidationError: healthy
        ? backend.lastValidationError
        : "Local filesystem health is not writable",
    });
    await this.publishBackendMetric(saved);

    if (!healthy) {
      throw platformUnavailableException(
        "StorageBackend health is not writable",
      );
    }
    return saved;
  }

  private async publishBackendMetric(backend: StorageBackendRow) {
    if (!this.observability) {
      return;
    }
    const usedBytes = await this.store.usedCapacity(backend.id);
    this.observability.recordStorageBackendSnapshot({
      id: backend.id,
      name: backend.name,
      status: backend.status,
      health: backend.health,
      maintenance: backend.maintenance,
      capacityTotal: backend.capacityTotal,
      capacityAvailable: backend.capacityAvailable,
      usedBytes,
    });
  }

  private assertPersistedWritable(backend: StorageBackendRow) {
    if (backend.type !== "LocalFilesystem") {
      throw platformUnavailableException("Unsupported StorageBackend type");
    }
    if (backend.maintenance) {
      throw platformUnavailableException("StorageBackend is in maintenance");
    }
    if (backend.status !== "Ready") {
      throw platformUnavailableException("StorageBackend is not Ready");
    }
    if (!this.isWritableHealth(backend.health)) {
      throw platformUnavailableException(
        "StorageBackend health is not writable",
      );
    }
    if (
      backend.capacityTotal === null ||
      backend.capacityAvailable === null
    ) {
      throw platformUnavailableException(
        "StorageBackend capacity is unavailable",
      );
    }
  }

  private assertCapacity(
    backend: StorageBackendRow,
    committedBytes: bigint,
    requestedReservationBytes: bigint,
    physicalGrowthBytes: bigint,
  ) {
    if (
      backend.capacityTotal === null ||
      backend.capacityAvailable === null
    ) {
      throw platformUnavailableException(
        "StorageBackend capacity is unavailable",
      );
    }
    if (committedBytes + requestedReservationBytes > backend.capacityTotal) {
      throw insufficientCapacityException("StorageBackend capacity exceeded");
    }
    if (physicalGrowthBytes > backend.capacityAvailable) {
      throw insufficientCapacityException(
        "StorageBackend available capacity exceeded",
      );
    }
  }

  private isWritableHealth(health: HealthState) {
    return health === HealthState.Healthy || health === HealthState.Degraded;
  }

  private mapBackend(backend: StorageBackendRow) {
    return {
      ...backend,
      capacityTotal: backend.capacityTotal?.toString() ?? null,
      capacityAvailable: backend.capacityAvailable?.toString() ?? null,
    };
  }
}
