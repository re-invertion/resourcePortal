import "fastify";
import "@fastify/cookie";
import { AuthenticatedUser, TenantContext } from "../auth/types";

declare module "fastify" {
  interface FastifyRequest {
    user: AuthenticatedUser;
    tenantContext?: TenantContext;
  }
}
