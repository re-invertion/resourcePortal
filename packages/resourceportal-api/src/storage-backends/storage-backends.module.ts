import { Module } from "@nestjs/common";
import { ObservabilityModule } from "../observability/observability.module";
import { PrismaModule } from "../prisma/prisma.module";
import { LocalFilesystemStorageAdapterService } from "./local-filesystem-storage-adapter.service";
import { NfsRemoteAccessValidatorService } from "./nfs-remote-access-validator.service";
import { StorageBackendStore } from "./storage-backend.store";
import { StorageBackendsService } from "./storage-backends.service";
import { StorageCommandRunnerService } from "./storage-command-runner.service";

@Module({
  imports: [PrismaModule, ObservabilityModule],
  providers: [
    StorageCommandRunnerService,
    LocalFilesystemStorageAdapterService,
    NfsRemoteAccessValidatorService,
    StorageBackendStore,
    StorageBackendsService,
  ],
  exports: [StorageBackendsService, StorageCommandRunnerService],
})
export class StorageBackendsModule {}
