import { Injectable } from "@nestjs/common";
import { IngressReconcilerService } from "../internal/ingress-reconciler.service";
import { RuntimeDriftReconcilerService } from "../internal/runtime-drift-reconciler.service";
import { SwarmInfrastructureService } from "../platform-infrastructure/swarm-infrastructure.service";
import { StorageBackendsService } from "../storage-backends/storage-backends.service";
import { RuntimeRestoreService } from "./runtime-restore.service";

@Injectable()
export class DisasterRecoveryService {
  constructor(
    private readonly swarm: SwarmInfrastructureService,
    private readonly storage: StorageBackendsService,
    private readonly runtimeRestore: RuntimeRestoreService,
    private readonly runtime: RuntimeDriftReconcilerService,
    private readonly ingress: IngressReconcilerService,
  ) {}

  async reconcileAfterRestore() {
    const swarm = await this.swarm.reconcile();

    const backends = await this.storage.listBackends();
    let storageFailed = 0;
    for (const backend of backends) {
      try {
        await this.storage.validateBackend(backend.id);
      } catch {
        storageFailed += 1;
      }
    }
    const storage = { checked: backends.length, failed: storageFailed };

    const runtimeRestore = await this.runtimeRestore.reconcile();
    const runtime = await this.runtime.reconcileBatch(10_000);
    const ingress = await this.ingress.reconcileBatch();

    const healthy =
      swarm.health === "Healthy" &&
      storage.failed === 0 &&
      runtimeRestore.failed === 0 &&
      runtimeRestore.skipped === 0 &&
      runtime.unknown === 0 &&
      runtime.drifted === 0 &&
      ingress.failed === 0;

    return {
      swarm,
      storage,
      runtimeRestore,
      runtime,
      ingress,
      healthy,
    };
  }
}
