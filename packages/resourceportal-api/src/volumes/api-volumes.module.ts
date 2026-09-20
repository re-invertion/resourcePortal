import { Module } from "@nestjs/common";
import { OperationsModule } from "../operations/operations.module";
import { PrismaModule } from "../prisma/prisma.module";
import { VolumeReadService } from "./volume-read.service";
import { VolumesController } from "./volumes.controller";

@Module({
  imports: [OperationsModule, PrismaModule],
  controllers: [VolumesController],
  providers: [VolumeReadService],
  exports: [VolumeReadService],
})
export class ApiVolumesModule {}
