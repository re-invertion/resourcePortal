import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { SecurityModule } from "../security/security.module";
import { PlatformServiceIdentitiesController } from "./platform-service-identities.controller";
import { PlatformServiceIdentitiesService } from "./platform-service-identities.service";
import { ServiceIdentitiesController } from "./service-identities.controller";
import { ServiceIdentitiesService } from "./service-identities.service";
import { ServiceIdentityCredentialsService } from "./service-identity-credentials.service";
import { ZitadelServiceIdentityService } from "./zitadel-service-identity.service";

@Module({
  imports: [PrismaModule, SecurityModule],
  controllers: [ServiceIdentitiesController, PlatformServiceIdentitiesController],
  providers: [
    ServiceIdentitiesService,
    PlatformServiceIdentitiesService,
    ServiceIdentityCredentialsService,
    ZitadelServiceIdentityService,
  ],
})
export class ServiceIdentitiesModule {}
