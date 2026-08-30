import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { VolumeStorageService } from "./volume-storage.service";
import { VolumesController } from "./volumes.controller";
import { VolumesService } from "./volumes.service";

@Module({
  imports: [PrismaModule],
  controllers: [VolumesController],
  providers: [VolumesService, VolumeStorageService],
  exports: [VolumesService],
})
export class VolumesModule {}
