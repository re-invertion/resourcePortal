import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { FastifyReply, FastifyRequest } from "fastify";
import { applyMcpBearerChallenge } from "./mcp-oauth";
import { TenantMcpSettingsService } from "./tenant-mcp-settings.service";

@Injectable()
export class TenantMcpAccessGuard implements CanActivate {
  constructor(
    private readonly settings: TenantMcpSettingsService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    const tenantId = (request.params as { tenantId?: string }).tenantId;
    if (!tenantId) throw new ForbiddenException("Tenant MCP requires a tenant context");

    await this.settings.assertMcpEnabled(tenantId);

    const authMode = this.config.get<string>("AUTH_MODE", "dev").toLowerCase();
    const bearer = this.extractBearerToken(request.headers.authorization);
    const devUserIdHeader = request.headers["x-dev-user-id"];
    const devUserId = Array.isArray(devUserIdHeader)
      ? devUserIdHeader[0]
      : devUserIdHeader;
    const hasInteractiveCredential =
      Boolean(bearer) || (authMode === "dev" && Boolean(devUserId));

    if (!hasInteractiveCredential) {
      // Standard MCP discovery/tool listing must remain reachable before OAuth
      // account linking. Protected tools return an MCP auth challenge at call time.
      return true;
    }

    if (request.serviceIdentity) {
      throw new ForbiddenException(
        "MCP user access requires an interactive Resource Portal user",
      );
    }
    if (!request.user) {
      applyMcpBearerChallenge(request, reply, tenantId);
      throw new UnauthorizedException(
        "Authenticated Resource Portal user is required",
      );
    }

    await this.settings.assertUserCanUseMcp(tenantId, request.user.id);
    return true;
  }

  private extractBearerToken(header: string | undefined) {
    if (!header) return undefined;
    const [scheme, token] = header.split(" ");
    return scheme?.toLowerCase() === "bearer" && token ? token : undefined;
  }
}
