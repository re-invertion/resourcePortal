import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { SecurityModule } from "../security/security.module";
import { OAuthApplicationsController } from "./oauth-applications.controller";
import { OAuthApplicationsService } from "./oauth-applications.service";
import { ZitadelOAuthApplicationService } from "./zitadel-oauth-application.service";

@Module({
  imports: [PrismaModule, SecurityModule],
  controllers: [OAuthApplicationsController],
  providers: [OAuthApplicationsService, ZitadelOAuthApplicationService],
})
export class OAuthApplicationsModule {}
