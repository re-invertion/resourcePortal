import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { SecurityModule } from "../security/security.module";
import { OAuthApplicationCredentialsService } from "./oauth-application-credentials.service";
import { OAuthApplicationsController } from "./oauth-applications.controller";
import { OAuthApplicationsService } from "./oauth-applications.service";
import { PlatformOAuthApplicationsController } from "./platform-oauth-applications.controller";
import { PlatformOAuthApplicationsService } from "./platform-oauth-applications.service";
import { ZitadelOAuthApplicationService } from "./zitadel-oauth-application.service";

@Module({
  imports: [PrismaModule, SecurityModule],
  controllers: [OAuthApplicationsController, PlatformOAuthApplicationsController],
  providers: [
    OAuthApplicationsService,
    PlatformOAuthApplicationsService,
    OAuthApplicationCredentialsService,
    ZitadelOAuthApplicationService,
  ],
})
export class OAuthApplicationsModule {}
