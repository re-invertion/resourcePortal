import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { StorageBackendsModule } from "../storage-backends/storage-backends.module";
import { VolumesService } from "./volumes.service";
import { VolumeUsageReconcilerService } from "./volume-usage-reconciler.service";

@Module({
  imports: [PrismaModule, StorageBackendsModule],
  providers: [VolumesService, VolumeUsageReconcilerService],
  exports: [VolumesService, VolumeUsageReconcilerService],
})
export class VolumesModule {}
