import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { FastifyReply, FastifyRequest } from "fastify";
import { isPlatformAdminUser } from "../auth/platform-admin.guard";
import { PrismaService } from "../prisma/prisma.service";
import { applyMcpBearerChallenge } from "./mcp-oauth";

@Injectable()
export class AdminMcpAccessGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    const authMode = this.config
      .get<string>("AUTH_MODE", "dev")
      .trim()
      .toLowerCase();
    const bearer = this.extractBearerToken(request.headers.authorization);
    const devUserIdHeader = request.headers["x-dev-user-id"];
    const devUserId = Array.isArray(devUserIdHeader)
      ? devUserIdHeader[0]
      : devUserIdHeader;
    const hasInteractiveCredential =
      Boolean(bearer) || (authMode === "dev" && Boolean(devUserId));

    // MCP discovery and tools/list must remain reachable before OAuth account
    // linking. Every tools/call is authenticated again by the protocol service.
    if (!hasInteractiveCredential) {
      return true;
    }

    if (request.serviceIdentity) {
      throw new ForbiddenException(
        "ResourcePortal Admin MCP requires an interactive platform administrator",
      );
    }
    if (!request.user) {
      applyMcpBearerChallenge(request, reply);
      throw new UnauthorizedException(
        "Authenticated ResourcePortal platform administrator is required",
      );
    }
    if (!(await isPlatformAdminUser(this.config, this.prisma, request.user))) {
      throw new ForbiddenException(
        "ResourcePortal platform administrator access is required",
      );
    }

    return true;
  }

  private extractBearerToken(header: string | undefined) {
    if (!header) return undefined;
    const [scheme, token] = header.split(" ");
    return scheme?.toLowerCase() === "bearer" && token ? token : undefined;
  }
}
