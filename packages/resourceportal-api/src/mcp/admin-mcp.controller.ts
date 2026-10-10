import {
  All,
  Controller,
  Get,
  Header,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { FastifyReply, FastifyRequest } from "fastify";
import { Public } from "../auth/public.decorator";
import { AllowDuringPlatformMaintenance } from "../platform-maintenance/allow-during-platform-maintenance.decorator";
import { AdminMcpAccessGuard } from "./admin-mcp-access.guard";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { AdminMcpProtocolService } from "./admin-mcp-protocol.service";
import { requestOrigin } from "./mcp-oauth";

@Controller("platform/mcp-catalog")
@UseGuards(PlatformAdminGuard)
export class AdminMcpCatalogController {
  constructor(private readonly protocol: AdminMcpProtocolService) {}

  @Get()
  list() {
    return { items: this.protocol.catalog() };
  }
}

@Public()
@AllowDuringPlatformMaintenance()
@Controller("platform/mcp")
@UseGuards(AdminMcpAccessGuard)
export class AdminMcpController {
  constructor(
    private readonly protocol: AdminMcpProtocolService,
    private readonly config: ConfigService,
  ) {}

  @All()
  async handle(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const authMode = this.config
      .get<string>("AUTH_MODE", "dev")
      .trim()
      .toLowerCase();
    const bearer = bearerToken(request.headers.authorization);
    const devUserId = headerValue(request.headers["x-dev-user-id"]);
    const hasInteractiveCredential =
      Boolean(bearer) || (authMode === "dev" && Boolean(devUserId));

    return this.protocol.handleHttp(
      {
        request,
        actor:
          hasInteractiveCredential && !request.serviceIdentity
            ? request.user
            : undefined,
        hasInteractiveCredential,
      },
      reply,
    );
  }
}

@Public()
@AllowDuringPlatformMaintenance()
@Controller(".well-known/oauth-protected-resource/api/platform/mcp")
export class AdminMcpOAuthMetadataController {
  constructor(private readonly config: ConfigService) {}

  @Get()
  @Header("access-control-allow-origin", "*")
  @Header("cache-control", "public, max-age=300")
  metadata(@Req() request: FastifyRequest) {
    const origin = requestOrigin(request);
    const issuer = this.config
      .get<string>("OIDC_ISSUER_URL")
      ?.replace(/\/$/, "");
    const projectId = this.config.get<string>("ZITADEL_PROJECT_ID");
    const organizationId = this.config.get<string>("ZITADEL_ORGANIZATION_ID");

    return {
      resource: origin ? `${origin}/api/platform/mcp` : undefined,
      resource_name: "ResourcePortal Admin MCP",
      authorization_servers: issuer ? [issuer] : [],
      bearer_methods_supported: ["header"],
      scopes_supported: [
        "openid",
        "profile",
        "email",
        "offline_access",
        ...(projectId
          ? [`urn:zitadel:iam:org:project:id:${projectId}:aud`]
          : []),
        ...(organizationId
          ? [`urn:zitadel:iam:org:id:${organizationId}`]
          : []),
      ],
      resource_documentation: origin
        ? `${origin}/help#resourceportal-admin-mcp`
        : undefined,
    };
  }
}

function bearerToken(header: string | undefined) {
  if (!header) return undefined;
  const [scheme, token] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && token ? token : undefined;
}

function headerValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}
