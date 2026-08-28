import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { RegistriesModule } from "../registries/registries.module";
import { StackRuntimeService } from "../internal/stack-runtime.service";
import { VolumesModule } from "../volumes/volumes.module";
import { AppGroupsController } from "./app-groups.controller";
import { AppGroupsService } from "./app-groups.service";

@Module({
  imports: [PrismaModule, RegistriesModule, VolumesModule],
  controllers: [AppGroupsController],
  providers: [AppGroupsService, StackRuntimeService],
})
export class AppGroupsModule {}
