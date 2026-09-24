import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import {
  McpOAuthAuthorizationServerMetadataController,
  TenantMcpController,
  TenantMcpOAuthMetadataController,
  TenantMcpSettingsController,
} from "./tenant-mcp.controller";
import { McpOAuthDcrController } from "./mcp-oauth-dcr.controller";
import { McpOAuthDcrService } from "./mcp-oauth-dcr.service";
import { TenantMcpAccessGuard } from "./tenant-mcp-access.guard";
import { TenantMcpProtocolService } from "./tenant-mcp-protocol.service";
import { TenantMcpSettingsService } from "./tenant-mcp-settings.service";

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [
    TenantMcpSettingsController,
    TenantMcpController,
    TenantMcpOAuthMetadataController,
    McpOAuthAuthorizationServerMetadataController,
    McpOAuthDcrController,
  ],
  providers: [
    TenantMcpSettingsService,
    TenantMcpAccessGuard,
    TenantMcpProtocolService,
    McpOAuthDcrService,
  ],
})
export class McpModule {}
