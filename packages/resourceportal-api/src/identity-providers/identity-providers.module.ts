import { Module } from "@nestjs/common";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { PrismaModule } from "../prisma/prisma.module";
import { SecurityModule } from "../security/security.module";
import { IdentityProvidersController } from "./identity-providers.controller";
import { IdentityProvidersService } from "./identity-providers.service";
import { PlatformIdentityProvidersController } from "./platform-identity-providers.controller";
import { PlatformIdentityProvidersService } from "./platform-identity-providers.service";
import { ZitadelIdentityProviderService } from "./zitadel-identity-provider.service";

@Module({
  imports: [PrismaModule, SecurityModule],
  controllers: [IdentityProvidersController, PlatformIdentityProvidersController],
  providers: [
    IdentityProvidersService,
    PlatformIdentityProvidersService,
    ZitadelIdentityProviderService,
    PlatformAdminGuard,
  ],
  exports: [IdentityProvidersService, PlatformIdentityProvidersService],
})
export class IdentityProvidersModule {}
