import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { SecurityModule } from "../security/security.module";
import { RegistriesController } from "./registries.controller";
import { RegistriesService } from "./registries.service";

@Module({
  imports: [PrismaModule, SecurityModule],
  controllers: [RegistriesController],
  providers: [RegistriesService],
  exports: [RegistriesService],
})
export class RegistriesModule {}
