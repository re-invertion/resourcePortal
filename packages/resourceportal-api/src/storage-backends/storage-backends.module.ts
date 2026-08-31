import { Module } from "@nestjs/common";
import { ObservabilityModule } from "../observability/observability.module";
import { PrismaModule } from "../prisma/prisma.module";
import { CephFsStorageAdapterService } from "./cephfs-storage-adapter.service";
import { NfsRemoteAccessValidatorService } from "./nfs-remote-access-validator.service";
import { StorageBackendReconcilerService } from "./storage-backend-reconciler.service";
import { StorageBackendStore } from "./storage-backend.store";
import { StorageBackendsController } from "./storage-backends.controller";
import { StorageBackendsService } from "./storage-backends.service";
import { StorageCommandRunnerService } from "./storage-command-runner.service";

@Module({
  imports: [PrismaModule, ObservabilityModule],
  controllers: [StorageBackendsController],
  providers: [
    StorageCommandRunnerService,
    CephFsStorageAdapterService,
    NfsRemoteAccessValidatorService,
    StorageBackendStore,
    StorageBackendsService,
    StorageBackendReconcilerService,
  ],
  exports: [StorageBackendsService],
})
export class StorageBackendsModule {}
