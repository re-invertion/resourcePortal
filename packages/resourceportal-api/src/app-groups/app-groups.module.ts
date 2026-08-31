import { Module } from "@nestjs/common";
import { CapacityModule } from "../capacity/capacity.module";
import { StackRuntimeService } from "../internal/stack-runtime.service";
import { PrismaModule } from "../prisma/prisma.module";
import { RegistriesModule } from "../registries/registries.module";
import { SecurityModule } from "../security/security.module";
import { VolumesModule } from "../volumes/volumes.module";
import { AppGroupsController } from "./app-groups.controller";
import { AppGroupsService } from "./app-groups.service";
import { Stage15AppGroupsService } from "./stage15-app-groups.service";

@Module({
  imports: [
    PrismaModule,
    RegistriesModule,
    SecurityModule,
    VolumesModule,
    CapacityModule,
  ],
  controllers: [AppGroupsController],
  providers: [
    {
      provide: AppGroupsService,
      useClass: Stage15AppGroupsService,
    },
    StackRuntimeService,
  ],
})
export class AppGroupsModule {}