import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { AdminMcpAccessGuard } from "./admin-mcp-access.guard";
import { AdminMcpAuditService } from "./admin-mcp-audit.service";
import {
  AdminMcpController,
  AdminMcpOAuthMetadataController,
} from "./admin-mcp.controller";
import { AdminMcpProtocolService } from "./admin-mcp-protocol.service";
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
    AdminMcpController,
    AdminMcpOAuthMetadataController,
    McpOAuthAuthorizationServerMetadataController,
    McpOAuthDcrController,
  ],
  providers: [
    TenantMcpSettingsService,
    TenantMcpAccessGuard,
    TenantMcpProtocolService,
    AdminMcpAccessGuard,
    AdminMcpAuditService,
    AdminMcpProtocolService,
    McpOAuthDcrService,
  ],
})
export class McpModule {}
