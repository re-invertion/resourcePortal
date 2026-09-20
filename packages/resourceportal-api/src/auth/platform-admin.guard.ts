import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { FastifyRequest } from "fastify";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<FastifyRequest>();

    if (!request.user || request.serviceIdentity) {
      throw new ForbiddenException("Platform administrator access is required");
    }

    const platformAdminIds = (
      this.config.get<string>("PLATFORM_ADMIN_USER_IDS") ?? ""
    )
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

    if (platformAdminIds.includes(request.user.id)) {
      return true;
    }

    const platformIssuer = this.config
      .get<string>("OIDC_ISSUER_URL")
      ?.replace(/\/$/, "");

    if (platformIssuer && platformAdminIds.length > 0) {
      const matchingIdentity = await this.prisma.userIdentity.findFirst({
        where: {
          userId: request.user.id,
          issuer: platformIssuer,
          externalSubject: {
            in: platformAdminIds,
          },
        },
        select: {
          id: true,
        },
      });

      if (matchingIdentity) {
        return true;
      }
    }

    throw new ForbiddenException("Platform administrator access is required");
  }
}
