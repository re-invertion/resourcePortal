import { SetMetadata } from "@nestjs/common";
import { MACHINE_BEARER_AUTH_KEY } from "./auth.constants";

/**
 * Opt-in for @Public() endpoints that enforce their own non-OIDC machine
 * bearer credential. The global user-auth guard must not consume the token.
 * This annotation never authenticates a request by itself.
 */
export const MachineBearerAuth = () => SetMetadata(MACHINE_BEARER_AUTH_KEY, true);
