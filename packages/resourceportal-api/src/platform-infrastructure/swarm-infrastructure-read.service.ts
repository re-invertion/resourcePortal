import { Injectable, NotFoundException } from "@nestjs/common";
import {
  SwarmInfrastructureStore,
  type RemoteLocationRow,
} from "./swarm-infrastructure.store";

@Injectable()
export class SwarmInfrastructureReadService {
  constructor(private readonly store: SwarmInfrastructureStore) {}

  async getCluster() {
    const cluster = await this.store.getCluster();
    if (!cluster) {
      throw new NotFoundException("Swarm cluster has not been reconciled yet");
    }
    return cluster;
  }

  async listRemoteLocations() {
    return (await this.store.listRemoteLocations()).map((item) => this.map(item));
  }

  async getRemoteLocation(id: string) {
    const item = await this.store.getRemoteLocation(id);
    if (!item) throw new NotFoundException("Remote Location not found");
    return this.map(item);
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
