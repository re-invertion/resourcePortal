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
        const validated = await this.storage.validateBackend(backend.id);
        // The storage service returns status=Error for failed checks instead
        // of throwing. Recovery must treat that as a failed gate.
        if (validated.status !== "Ready") storageFailed += 1;
      } catch {
        storageFailed += 1;
      }
    }
    const storage = { checked: backends.length, failed: storageFailed };

    const runtimeRestore = await this.runtimeRestore.reconcile();
    // A batch is silently capped at 500; recovery must inspect *every*
    // deployed group, including failures beyond the first page.
    const runtime = await this.runtime.reconcileAll();
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
