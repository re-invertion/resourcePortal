import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { SecurityModule } from "../security/security.module";
import { AuthController } from "./auth.controller";
import { AuthFlowService } from "./auth-flow.service";
import { AuthSessionService } from "./auth-session.service";
import { OidcAuthService } from "./oidc-auth.service";
import { FederationProofService } from "./federation-proof.service";

@Module({
  imports: [PrismaModule, SecurityModule],
  controllers: [AuthController],
  providers: [AuthFlowService, AuthSessionService, OidcAuthService, FederationProofService],
  exports: [AuthSessionService, OidcAuthService],
})
export class AuthModule {}
