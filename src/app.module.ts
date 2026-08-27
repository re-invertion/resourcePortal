import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AppGroupsModule } from "./app-groups/app-groups.module";
import { DevAuthGuard } from "./auth/dev-auth.guard";
import { PermissionsGuard } from "./auth/permissions.guard";
import { TenantContextGuard } from "./auth/tenant-context.guard";
import { ConfigModule } from "@nestjs/config";
import { DomainsModule } from "./domains/domains.module";
import { HealthModule } from "./health/health.module";
import { InternalModule } from "./internal/internal.module";
import { PrismaModule } from "./prisma/prisma.module";
import { RegistriesModule } from "./registries/registries.module";
import { TenantsModule } from "./tenants/tenants.module";
import { UsersModule } from "./users/users.module";
import { VolumesModule } from "./volumes/volumes.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    PrismaModule,
    HealthModule,
    UsersModule,
    TenantsModule,
    AppGroupsModule,
    RegistriesModule,
    VolumesModule,
    DomainsModule,
    InternalModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: DevAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: TenantContextGuard,
    },
    {
      provide: APP_GUARD,
      useClass: PermissionsGuard,
    },
  ],
})
export class AppModule {}
