import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { BillingModule } from "./billing/billing.module";
import { BillingWorkerService } from "./billing/billing-worker.service";
import { validateWorkerEnv } from "./config/worker-env.validation";
import { WorkerExecutionModule } from "./worker-execution.module";
import { ObservabilityModule } from "./observability/observability.module";
import { PlatformInfrastructureModule } from "./platform-infrastructure/platform-infrastructure.module";
import { SwarmInfrastructureReconcilerService } from "./platform-infrastructure/swarm-infrastructure-reconciler.service";
import { PrismaModule } from "./prisma/prisma.module";
import { StorageBackendReconcilerService } from "./storage-backends/storage-backend-reconciler.service";
import { StorageBackendsModule } from "./storage-backends/storage-backends.module";
import { VolumesModule } from "./volumes/volumes.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateWorkerEnv }),
    PrismaModule,
    BillingModule,
    ObservabilityModule,
    PlatformInfrastructureModule,
    StorageBackendsModule,
    VolumesModule,
    WorkerExecutionModule,
  ],
  providers: [
    BillingWorkerService,
    SwarmInfrastructureReconcilerService,
    StorageBackendReconcilerService,
  ],
})
export class WorkerModule {}
