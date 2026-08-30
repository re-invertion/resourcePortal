import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { RegistriesModule } from "../registries/registries.module";
import { SecurityModule } from "../security/security.module";
import { StackRuntimeService } from "../internal/stack-runtime.service";
import { VolumesModule } from "../volumes/volumes.module";
import { AppGroupsController } from "./app-groups.controller";
import { AppGroupsService } from "./app-groups.service";
import { Stage11AppGroupsService } from "./stage11-app-groups.service";

@Module({
  imports: [PrismaModule, RegistriesModule, SecurityModule, VolumesModule],
  controllers: [AppGroupsController],
  providers: [
    {
      provide: AppGroupsService,
      useClass: Stage11AppGroupsService,
    },
    StackRuntimeService,
  ],
})
export class AppGroupsModule {}
