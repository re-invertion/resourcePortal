import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import { UserStatus } from "@prisma/client";
import { FastifyRequest } from "fastify";
import { AuthenticatedUser } from "./types";

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser | undefined => {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (request.user) return request.user;

    if (request.serviceIdentity) {
      return {
        id: request.serviceIdentity.id,
        email: "",
        displayName: request.serviceIdentity.name,
        status: UserStatus.Active,
      };
    }

    return undefined;
  },
);
