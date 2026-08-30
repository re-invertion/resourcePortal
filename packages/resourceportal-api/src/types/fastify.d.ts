import "fastify";
import "@fastify/cookie";
import {
  AuthenticatedServiceIdentity,
  AuthenticatedUser,
  TenantContext,
} from "../auth/types";

declare module "fastify" {
  interface FastifyRequest {
    user: AuthenticatedUser;
    serviceIdentity?: AuthenticatedServiceIdentity;
    tenantContext?: TenantContext;
  }
}
