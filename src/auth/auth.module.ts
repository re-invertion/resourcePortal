import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { AuthController } from "./auth.controller";
import { AuthFlowService } from "./auth-flow.service";
import { AuthSessionService } from "./auth-session.service";
import { OidcAuthService } from "./oidc-auth.service";

@Module({
  imports: [PrismaModule],
  controllers: [AuthController],
  providers: [AuthFlowService, AuthSessionService, OidcAuthService],
  exports: [AuthSessionService, OidcAuthService],
})
export class AuthModule {}
