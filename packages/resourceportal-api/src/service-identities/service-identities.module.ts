import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { SecurityModule } from "../security/security.module";
import { ServiceIdentitiesController } from "./service-identities.controller";
import { ServiceIdentitiesService } from "./service-identities.service";
import { ZitadelServiceIdentityService } from "./zitadel-service-identity.service";

@Module({
  imports: [PrismaModule, SecurityModule],
  controllers: [ServiceIdentitiesController],
  providers: [ServiceIdentitiesService, ZitadelServiceIdentityService],
})
export class ServiceIdentitiesModule {}
