import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SwarmInfrastructureService } from "./swarm-infrastructure.service";

@Injectable()
export class SwarmInfrastructureReconcilerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(SwarmInfrastructureReconcilerService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly service: SwarmInfrastructureService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    const intervalMs = this.config.get<number>(
      "SWARM_INFRASTRUCTURE_RECONCILE_INTERVAL_MS",
      30000,
    );

    this.timer = setInterval(() => {
      void this.reconcileOnce();
    }, intervalMs);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async reconcileOnce() {
    if (this.running) {
      return;
    }

    this.running = true;
    try {
      await this.service.reconcile();
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      this.logger.warn(`Swarm infrastructure reconcile failed: ${message}`);
    } finally {
      this.running = false;
    }
  }
}
