import { Module } from "@nestjs/common";
import { CapacityModule } from "../capacity/capacity.module";
import { PrismaModule } from "../prisma/prisma.module";
import { PlatformMaintenanceModule } from "../platform-maintenance/platform-maintenance.module";
import { OperationsModule } from "../operations/operations.module";
import { RegistriesModule } from "../registries/registries.module";
import { SecurityModule } from "../security/security.module";
import { ApiVolumesModule } from "../volumes/api-volumes.module";
import { AppGroupsController } from "./app-groups.controller";
import { AppGroupRuntimeOperationsService } from "./app-group-runtime-operations.service";
import { AppGroupManifestService } from "./app-group-manifest.service";
import { AppGroupsService } from "./app-groups.service";
import { Stage15AppGroupsService } from "./stage15-app-groups.service";

@Module({
  imports: [
    PrismaModule,
    RegistriesModule,
    SecurityModule,
    ApiVolumesModule,
    CapacityModule,
    OperationsModule,
    PlatformMaintenanceModule,
  ],
  controllers: [AppGroupsController],
  providers: [
    AppGroupRuntimeOperationsService,
    AppGroupManifestService,
    {
      provide: AppGroupsService,
      useClass: Stage15AppGroupsService,
    },
  ],
})
export class AppGroupsModule {}