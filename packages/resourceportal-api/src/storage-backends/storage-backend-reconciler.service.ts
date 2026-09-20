import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { StorageBackendsService } from "./storage-backends.service";

@Injectable()
export class StorageBackendReconcilerService
  implements OnModuleInit, OnModuleDestroy
{
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly config: ConfigService,
    private readonly storageBackends: StorageBackendsService,
  ) {}

  onModuleInit() {
    if (this.oneShot()) return;
    void this.reconcile();
    const intervalMs = this.config.get<number>(
      "STORAGE_BACKEND_RECONCILE_INTERVAL_MS",
      30000,
    );
    this.timer = setInterval(() => void this.reconcile(), intervalMs);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private oneShot() {
    return ["1", "true", "yes", "on"].includes(
      (this.config.get<string>("WORKER_ONCE") ?? "").trim().toLowerCase(),
    );
  }

  private async reconcile() {
    await this.storageBackends.validateDefaultBackend().catch(() => undefined);
  }
}
