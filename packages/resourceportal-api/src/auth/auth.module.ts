import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { SecurityModule } from "../security/security.module";
import { AuthController } from "./auth.controller";
import { AuthFlowService } from "./auth-flow.service";
import { AuthSessionService } from "./auth-session.service";
import { OidcAuthService } from "./oidc-auth.service";
import { FederationProofService } from "./federation-proof.service";
import { NativeLoginModeService } from "./native-login-mode.service";
import { McpResourceOAuthService } from "./mcp-resource-oauth.service";
import { McpUpstreamLoginService } from "./mcp-upstream-login.service";

@Module({
  imports: [PrismaModule, SecurityModule],
  controllers: [AuthController],
  providers: [AuthFlowService, AuthSessionService, OidcAuthService, FederationProofService, NativeLoginModeService, McpResourceOAuthService, McpUpstreamLoginService],
  exports: [AuthSessionService, OidcAuthService, NativeLoginModeService, McpResourceOAuthService, McpUpstreamLoginService],
})
export class AuthModule {}
