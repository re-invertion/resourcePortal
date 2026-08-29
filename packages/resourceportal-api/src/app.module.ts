import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AppGroupsModule } from "./app-groups/app-groups.module";
import { AuditModule } from "./audit/audit.module";
import { AuthModule } from "./auth/auth.module";
import { DevAuthGuard } from "./auth/dev-auth.guard";
import { PermissionsGuard } from "./auth/permissions.guard";
import { TenantContextGuard } from "./auth/tenant-context.guard";
import { ConfigModule } from "@nestjs/config";
import { validateEnv } from "./config/env.validation";
import { DomainsModule } from "./domains/domains.module";
import { HealthModule } from "./health/health.module";
import { IdentityProvidersModule } from "./identity-providers/identity-providers.module";
import { InternalModule } from "./internal/internal.module";
import { ObservabilityModule } from "./observability/observability.module";
import { PrismaModule } from "./prisma/prisma.module";
import { RegistriesModule } from "./registries/registries.module";
import { SecurityModule } from "./security/security.module";
import { TenantsModule } from "./tenants/tenants.module";
import { UsersModule } from "./users/users.module";
import { VolumesModule } from "./volumes/volumes.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: [".env", "../../.env"],
      isGlobal: true,
      validate: validateEnv,
    }),
    PrismaModule,
    SecurityModule,
    AuthModule,
    HealthModule,
    UsersModule,
    TenantsModule,
    IdentityProvidersModule,
    AppGroupsModule,
    RegistriesModule,
    VolumesModule,
    DomainsModule,
    AuditModule,
    InternalModule,
    ObservabilityModule,
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
