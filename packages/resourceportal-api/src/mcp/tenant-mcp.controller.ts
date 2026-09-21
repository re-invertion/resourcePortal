import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { FastifyReply, FastifyRequest } from "fastify";
import { CurrentUser } from "../auth/current-user.decorator";
import { Public } from "../auth/public.decorator";
import { RequirePermissions } from "../auth/require-permissions.decorator";
import { AuthenticatedUser } from "../auth/types";
import { AllowDuringPlatformMaintenance } from "../platform-maintenance/allow-during-platform-maintenance.decorator";
import { UpdateTenantMcpSettingsDto } from "./dto/update-tenant-mcp-settings.dto";
import { requestOrigin } from "./mcp-oauth";
import { TenantMcpAccessGuard } from "./tenant-mcp-access.guard";
import { TenantMcpProtocolService } from "./tenant-mcp-protocol.service";
import { TenantMcpSettingsService } from "./tenant-mcp-settings.service";

@Controller("tenants/:tenantId/mcp-settings")
export class TenantMcpSettingsController {
  constructor(private readonly settings: TenantMcpSettingsService) {}

  @RequirePermissions("tenant.settings.update")
  @Get()
  get(@Param("tenantId", ParseUUIDPipe) tenantId: string) {
    return this.settings.getSettings(tenantId);
  }

  @RequirePermissions("tenant.settings.update")
  @Patch()
  update(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body() dto: UpdateTenantMcpSettingsDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.settings.updateSettings(tenantId, dto, actor);
  }
}

@Controller("tenants/:tenantId/mcp")
@UseGuards(TenantMcpAccessGuard)
export class TenantMcpController {
  constructor(private readonly protocol: TenantMcpProtocolService) {}

  @Post()
  @HttpCode(200)
  async post(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const response = await this.protocol.handle({ tenantId, request, actor }, body);
    reply.header("cache-control", "no-store");
    if (response.body === undefined) return reply.status(response.statusCode).send();
    return reply.status(response.statusCode).send(response.body);
  }
}

@Public()
@AllowDuringPlatformMaintenance()
@Controller(".well-known/oauth-protected-resource/api/tenants/:mcpTenantId/mcp")
export class TenantMcpOAuthMetadataController {
  constructor(private readonly config: ConfigService) {}

  @Get()
  @Header("access-control-allow-origin", "*")
  @Header("cache-control", "public, max-age=300")
  metadata(
    @Param("mcpTenantId", ParseUUIDPipe) tenantId: string,
    @Req() request: FastifyRequest,
  ) {
    const origin = requestOrigin(request);
    const issuer = this.config.get<string>("OIDC_ISSUER_URL")?.replace(/\/$/, "");
    const projectId = this.config.get<string>("ZITADEL_PROJECT_ID");
    const organizationId = this.config.get<string>("ZITADEL_ORGANIZATION_ID");
    return {
      resource: origin ? `${origin}/api/tenants/${encodeURIComponent(tenantId)}/mcp` : undefined,
      resource_name: "ResourcePortal Tenant MCP",
      authorization_servers: issuer ? [issuer] : [],
      bearer_methods_supported: ["header"],
      scopes_supported: [
        "openid",
        "profile",
        "email",
        ...(projectId ? [`urn:zitadel:iam:org:project:id:${projectId}:aud`] : []),
        ...(organizationId ? [`urn:zitadel:iam:org:id:${organizationId}`] : []),
      ],
      resource_documentation: origin
        ? `${origin}/tenants/${encodeURIComponent(tenantId)}/settings#mcp`
        : undefined,
    };
  }
}
