import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { AppGroupsModule } from "./app-groups/app-groups.module";
import { AuditModule } from "./audit/audit.module";
import { AuthModule } from "./auth/auth.module";
import { DevAuthGuard } from "./auth/dev-auth.guard";
import { PermissionsGuard } from "./auth/permissions.guard";
import { TenantContextGuard } from "./auth/tenant-context.guard";
import { BillingModule } from "./billing/billing.module";
import { BillingPreflightGuard } from "./billing/billing-preflight.guard";
import { validateEnv } from "./config/env.validation";
import { DisasterRecoveryModule } from "./disaster-recovery/disaster-recovery.module";
import { DomainsModule } from "./domains/domains.module";
import { HealthModule } from "./health/health.module";
import { IdentityProvidersModule } from "./identity-providers/identity-providers.module";
import { InternalModule } from "./internal/internal.module";
import { OAuthApplicationsModule } from "./oauth-applications/oauth-applications.module";
import { ObservabilityModule } from "./observability/observability.module";
import { OperationsModule } from "./operations/operations.module";
import { PlatformInfrastructureModule } from "./platform-infrastructure/platform-infrastructure.module";
import { PlatformMaintenanceGuard } from "./platform-maintenance/platform-maintenance.guard";
import { PlatformMaintenanceModule } from "./platform-maintenance/platform-maintenance.module";
import { PrismaModule } from "./prisma/prisma.module";
import { RegistriesModule } from "./registries/registries.module";
import { SecurityModule } from "./security/security.module";
import { ServiceIdentitiesModule } from "./service-identities/service-identities.module";
import { StorageBackendsModule } from "./storage-backends/storage-backends.module";
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
    PlatformMaintenanceModule,
    SecurityModule,
    AuthModule,
    HealthModule,
    UsersModule,
    BillingModule,
    TenantsModule,
    IdentityProvidersModule,
    OAuthApplicationsModule,
    ServiceIdentitiesModule,
    AppGroupsModule,
    RegistriesModule,
    VolumesModule,
    DomainsModule,
    OperationsModule,
    AuditModule,
    InternalModule,
    ObservabilityModule,
    PlatformInfrastructureModule,
    StorageBackendsModule,
    DisasterRecoveryModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: PlatformMaintenanceGuard,
    },
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
    {
      provide: APP_GUARD,
      useClass: BillingPreflightGuard,
    },
  ],
})
export class AppModule {}
