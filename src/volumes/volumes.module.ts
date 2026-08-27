import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { VolumesController } from "./volumes.controller";
import { VolumesService } from "./volumes.service";

@Module({
  imports: [PrismaModule],
  controllers: [VolumesController],
  providers: [VolumesService],
  exports: [VolumesService],
})
export class VolumesModule {}
