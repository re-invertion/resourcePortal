import {
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { HealthState } from "@prisma/client";
import { AuthenticatedUser } from "../auth/types";
import { CephFsStorageAdapterService } from "./cephfs-storage-adapter.service";
import { NfsRemoteAccessValidatorService } from "./nfs-remote-access-validator.service";
import { StorageBackendRow, StorageBackendStore } from "./storage-backend.store";

@Injectable()
export class StorageBackendsService {
  constructor(
    private readonly store: StorageBackendStore,
    private readonly cephFs: CephFsStorageAdapterService,
    private readonly remoteAccess: NfsRemoteAccessValidatorService,
  ) {}

  async listBackends() {
    return Promise.all((await this.store.list()).map((backend) => this.mapBackend(backend)));
  }

  async getBackend(id: string) {
    return this.mapBackend(await this.store.require(id));
  }

  async validateBackend(id: string) {
    const backend = await this.store.require(id);
    const now = new Date();

    try {
      const local = await this.cephFs.validateLocal();
      const remote = await this.remoteAccess.validate(backend.basePath);
      const healthReady =
        local.health === HealthState.Healthy ||
        local.health === HealthState.Degraded;
      const ready = healthReady && remote.ok;
      const error = remote.error;

      return this.mapBackend(
        await this.store.saveValidation(id, {
          status: ready ? "Ready" : "Error",
          health: local.health,
          capacityTotal: local.capacityTotal,
          capacityAvailable: local.capacityAvailable,
          lastValidatedAt: now,
          lastValidationError: ready && !remote.skipped ? null : error,
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "StorageBackend validation failed";
      return this.mapBackend(
        await this.store.saveValidation(id, {
          status: "Error",
          health: HealthState.Unknown,
          capacityTotal: null,
          capacityAvailable: null,
          lastValidatedAt: now,
          lastValidationError: message,
        }),
      );
    }
  }

  async validateDefaultBackend() {
    const backend = await this.store.requireDefault();
    return this.validateBackend(backend.id);
  }

  async setMaintenance(id: string, enabled: boolean, _actor: AuthenticatedUser) {
    return this.mapBackend(await this.store.setMaintenance(id, enabled));
  }

  async provisionVolume(input: {
    tenantId: string;
    volumeId: string;
    sizeBytes: bigint;
  }) {
    const backend = await this.requireWritableBackend(input.sizeBytes);
    const result = await this.cephFs.provisionVolume(backend, input);
    return { backendId: backend.id, storagePath: result.storagePath };
  }

  async cleanupProvisionedVolume(backendId: string, storagePath: string) {
    const backend = await this.store.require(backendId);
    await this.cephFs.deleteVolume(backend, storagePath);
  }

  async resizeVolume(input: {
    volumeId: string;
    storagePath: string;
    requestedSizeBytes: bigint;
    currentSizeBytes: bigint;
  }) {
    const growth = input.requestedSizeBytes - input.currentSizeBytes;
    if (growth < 0n) {
      throw new ConflictException("Volume cannot be shrunk");
    }
    if (growth === 0n) return;

    const backend = await this.store.requireForVolume(input.volumeId);
    await this.assertWritableBackend(backend, growth);
    await this.cephFs.resizeVolume(
      backend,
      input.storagePath,
      input.requestedSizeBytes,
    );
  }

  async deleteVolume(volumeId: string, storagePath: string) {
    const backend = await this.store.requireForVolume(volumeId);
    await this.cephFs.deleteVolume(backend, storagePath);
  }

  async measureUsedSize(volumeId: string, storagePath: string) {
    const backend = await this.store.requireForVolume(volumeId);
    return this.cephFs.measureUsedSize(backend, storagePath);
  }

  runtimeVolumeDefinition(storagePath: string) {
    return {
      driver: "local" as const,
      driver_opts: this.cephFs.runtimeDriverOptions(storagePath),
    };
  }

  private async requireWritableBackend(requiredBytes: bigint) {
    const backend = await this.store.requireDefault();
    await this.assertWritableBackend(backend, requiredBytes);
    return backend;
  }

  private async assertWritableBackend(
    backend: StorageBackendRow,
    requiredBytes: bigint,
  ) {
    if (backend.maintenance) {
      throw new ServiceUnavailableException("StorageBackend is in maintenance");
    }
    if (backend.status !== "Ready") {
      throw new ServiceUnavailableException("StorageBackend is not Ready");
    }

    const live = await this.cephFs.validateLocal();
    const healthy =
      live.health === HealthState.Healthy || live.health === HealthState.Degraded;
    await this.store.saveValidation(backend.id, {
      status: healthy ? backend.status : "Error",
      health: live.health,
      capacityTotal: live.capacityTotal,
      capacityAvailable: live.capacityAvailable,
      lastValidatedAt: new Date(),
      lastValidationError: healthy ? backend.lastValidationError : "Ceph health is not writable",
    });

    if (!healthy) {
      throw new ServiceUnavailableException("StorageBackend health is not writable");
    }
    if (live.capacityAvailable < requiredBytes) {
      throw new ConflictException("StorageBackend capacity exceeded");
    }
  }

  private mapBackend(backend: StorageBackendRow) {
    return {
      ...backend,
      capacityTotal: backend.capacityTotal?.toString() ?? null,
      capacityAvailable: backend.capacityAvailable?.toString() ?? null,
    };
  }
}
