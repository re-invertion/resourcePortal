import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { SecurityModule } from "../security/security.module";
import { IdentityProvidersController } from "./identity-providers.controller";
import { IdentityProvidersService } from "./identity-providers.service";
import { ZitadelIdentityProviderService } from "./zitadel-identity-provider.service";

@Module({
  imports: [PrismaModule, SecurityModule],
  controllers: [IdentityProvidersController],
  providers: [IdentityProvidersService, ZitadelIdentityProviderService],
  exports: [IdentityProvidersService],
})
export class IdentityProvidersModule {}
