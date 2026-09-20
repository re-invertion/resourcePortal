import { Injectable } from "@nestjs/common";
import type { AuthenticatedUser } from "../auth/types";
import { StorageBackendStore, type StorageBackendRow } from "./storage-backend.store";

@Injectable()
export class StorageBackendsApiService {
  constructor(private readonly store: StorageBackendStore) {}

  async listBackends() {
    return (await this.store.list()).map((backend) => this.mapBackend(backend));
  }

  async getBackend(id: string) {
    return this.mapBackend(await this.store.require(id));
  }

  async setMaintenance(id: string, enabled: boolean, actor: AuthenticatedUser) {
    void actor;
    return this.mapBackend(await this.store.setMaintenance(id, enabled));
  }

  private mapBackend(backend: StorageBackendRow) {
    return {
      ...backend,
      capacityTotal: backend.capacityTotal?.toString() ?? null,
      capacityAvailable: backend.capacityAvailable?.toString() ?? null,
    };
  }
}
