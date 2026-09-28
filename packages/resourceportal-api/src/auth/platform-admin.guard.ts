import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { FastifyRequest } from "fastify";
import { PrismaService } from "../prisma/prisma.service";
import { AuthenticatedUser } from "./types";

export async function isPlatformAdminUser(
  config: ConfigService,
  prisma: PrismaService,
  user: Pick<AuthenticatedUser, "id"> | undefined,
) {
  if (!user) return false;

  const platformAdminIds = (config.get<string>("PLATFORM_ADMIN_USER_IDS") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (platformAdminIds.includes(user.id)) {
    return true;
  }

  const platformIssuer = config
    .get<string>("OIDC_ISSUER_URL")
    ?.replace(/\/$/, "");

  if (!platformIssuer || platformAdminIds.length === 0) {
    return false;
  }

  const matchingIdentity = await prisma.userIdentity.findFirst({
    where: {
      userId: user.id,
      issuer: platformIssuer,
      externalSubject: {
        in: platformAdminIds,
      },
    },
    select: {
      id: true,
    },
  });

  return Boolean(matchingIdentity);
}

@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<FastifyRequest>();

    if (
      request.serviceIdentity ||
      !(await isPlatformAdminUser(this.config, this.prisma, request.user))
    ) {
      throw new ForbiddenException("Platform administrator access is required");
    }

    return true;
  }
}
