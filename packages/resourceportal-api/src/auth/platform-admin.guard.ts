import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { FastifyRequest } from "fastify";

@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<FastifyRequest>();

    if (!request.user || request.serviceIdentity) {
      throw new ForbiddenException("Platform administrator access is required");
    }

    const platformAdminIds = (this.config.get<string>("PLATFORM_ADMIN_USER_IDS") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

    if (!platformAdminIds.includes(request.user.id)) {
      throw new ForbiddenException("Platform administrator access is required");
    }

    return true;
  }
}
