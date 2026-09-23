import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  InternalServerErrorException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { UserStatus } from "@prisma/client";
import { FastifyReply, FastifyRequest } from "fastify";
import { applyMcpBearerChallenge, isTenantMcpRequest } from "../mcp/mcp-oauth";
import { PrismaService } from "../prisma/prisma.service";
import { IS_PUBLIC_KEY } from "./auth.constants";
import { AuthSessionService } from "./auth-session.service";
import { OidcAuthService } from "./oidc-auth.service";

@Injectable()
export class DevAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly oidcAuth: OidcAuthService,
    private readonly sessions: AuthSessionService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const authMode = this.getAuthMode();

    if (authMode === "oidc") {
      const reply = context.switchToHttp().getResponse<FastifyReply>();
      return this.authenticateOidcRequest(request, reply, isPublic);
    }

    return this.authenticateDevRequest(request, isPublic);
  }

  private async authenticateDevRequest(
    request: FastifyRequest,
    isPublic: boolean | undefined,
  ) {
    const userIdHeader = request.headers["x-dev-user-id"];
    const userId = Array.isArray(userIdHeader) ? userIdHeader[0] : userIdHeader;

    if (!userId) {
      if (isPublic) return true;
      throw new UnauthorizedException("x-dev-user-id header is required");
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        displayName: true,
        status: true,
      },
    });

    if (!user || user.status !== UserStatus.Active) {
      throw new UnauthorizedException("Active user not found");
    }

    request.user = user;
    return true;
  }

  private async authenticateOidcRequest(
    request: FastifyRequest,
    reply: FastifyReply,
    isPublic: boolean | undefined,
  ) {
    const token = this.extractBearerToken(request.headers.authorization);

    if (token) {
      let principal;
      try {
        principal = isTenantMcpRequest(request)
          ? await this.oidcAuth.authenticateMcpPrincipalToken(token)
          : await this.oidcAuth.authenticatePrincipalToken(token);
      } catch (error) {
        if (isTenantMcpRequest(request)) applyMcpBearerChallenge(request, reply);
        throw error;
      }
      if (principal.type === "ServiceIdentity") {
        const tenantId = (request.params as { tenantId?: string }).tenantId;
        if (!tenantId) {
          throw new ForbiddenException(
            "Service identities can access tenant-scoped endpoints only",
          );
        }
        request.serviceIdentity = principal.serviceIdentity;
        request.user = {
          id: principal.serviceIdentity.id,
          email: `service-identity+${principal.serviceIdentity.id}@resourceportal.invalid`,
          displayName: principal.serviceIdentity.name,
          status: UserStatus.Active,
        };
        return true;
      }

      request.user = principal.user;
      return true;
    }

    const hasSessionCookie = this.sessions.hasSessionCookie(request);
    const sessionId = this.sessions.getSessionIdFromRequest(request);
    if (sessionId) {
      try {
        request.user = await this.sessions.authenticateSession(sessionId);
        return true;
      } catch (error) {
        await this.sessions.invalidateRequestSession(request, reply);
        throw error;
      }
    }

    if (hasSessionCookie) {
      this.sessions.clearSessionCookies(reply);
    }

    if (isPublic) return true;

    if (isTenantMcpRequest(request)) applyMcpBearerChallenge(request, reply);
    throw new UnauthorizedException(
      "Authorization bearer token or session cookie is required",
    );
  }

  private extractBearerToken(header: string | undefined) {
    if (!header) return undefined;
    const [scheme, token] = header.split(" ");
    if (scheme?.toLowerCase() !== "bearer" || !token) return undefined;
    return token;
  }

  private getAuthMode() {
    const authMode = this.config
      .get<string>("AUTH_MODE", "dev")
      .trim()
      .toLowerCase();
    const nodeEnv = this.config
      .get<string>("NODE_ENV", "development")
      .trim()
      .toLowerCase();

    if (nodeEnv === "production" && authMode === "dev") {
      throw new InternalServerErrorException(
        "AUTH_MODE=dev is not allowed in production",
      );
    }

    if (authMode === "dev" || authMode === "oidc" || authMode === "zitadel") {
      return authMode === "zitadel" ? "oidc" : authMode;
    }
    throw new InternalServerErrorException(`Unsupported AUTH_MODE: ${authMode}`);
  }
}
