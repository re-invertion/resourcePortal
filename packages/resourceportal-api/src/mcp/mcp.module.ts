import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import {
  TenantMcpController,
  TenantMcpOAuthMetadataController,
  TenantMcpSettingsController,
} from "./tenant-mcp.controller";
import { TenantMcpAccessGuard } from "./tenant-mcp-access.guard";
import { TenantMcpProtocolService } from "./tenant-mcp-protocol.service";
import { TenantMcpSettingsService } from "./tenant-mcp-settings.service";

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [
    TenantMcpSettingsController,
    TenantMcpController,
    TenantMcpOAuthMetadataController,
  ],
  providers: [TenantMcpSettingsService, TenantMcpAccessGuard, TenantMcpProtocolService],
})
export class McpModule {}
