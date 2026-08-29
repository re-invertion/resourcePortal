import { Module } from "@nestjs/common";
import { IdentityProvidersController } from "./identity-providers.controller";
import { IdentityProvidersService } from "./identity-providers.service";

@Module({
  controllers: [IdentityProvidersController],
  providers: [IdentityProvidersService],
  exports: [IdentityProvidersService],
})
export class IdentityProvidersModule {}
