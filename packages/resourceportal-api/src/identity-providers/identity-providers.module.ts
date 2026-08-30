import { Module } from "@nestjs/common";
import { SecurityModule } from "../security/security.module";
import { IdentityProvidersController } from "./identity-providers.controller";
import { IdentityProvidersService } from "./identity-providers.service";
import { ZitadelIdentityProviderService } from "./zitadel-identity-provider.service";

@Module({
  imports: [SecurityModule],
  controllers: [IdentityProvidersController],
  providers: [IdentityProvidersService, ZitadelIdentityProviderService],
  exports: [IdentityProvidersService],
})
export class IdentityProvidersModule {}
