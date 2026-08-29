import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { FastifyRequest } from "fastify";

@Injectable()
export class InternalAuthGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const tokenHeader = request.headers["x-internal-token"];
    const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
    const expectedToken = this.config.get<string>(
      "INTERNAL_WORKER_TOKEN",
      "dev-worker-token",
    );

    if (!token || token !== expectedToken) {
      throw new UnauthorizedException("Invalid internal token");
    }

    return true;
  }
}
