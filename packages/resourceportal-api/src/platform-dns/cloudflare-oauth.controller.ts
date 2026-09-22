import { BadRequestException, Controller, Get, Query, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthenticatedUser } from "../auth/types";
import { CloudflareTenantOauthService } from "./cloudflare-tenant-oauth.service";

@Controller("integrations/cloudflare/oauth")
export class CloudflareOauthController {
  constructor(private readonly oauth: CloudflareTenantOauthService) {}

  @Get("callback")
  async callback(
    @Query("code") code: string | undefined,
    @Query("state") state: string | undefined,
    @Query("error") providerError: string | undefined,
    @CurrentUser() actor: AuthenticatedUser,
    @Res() reply: FastifyReply,
  ) {
    if (!state) {
      throw new BadRequestException("Cloudflare OAuth state is required");
    }
    const tenantId = await this.oauth.resolveStateTenant(state, actor.id).catch(() => undefined);
    const fallback = tenantId
      ? `/tenants/${encodeURIComponent(tenantId)}/domains?cloudflare=error`
      : "/tenants?cloudflare=error";
    if (providerError || !code) {
      return reply.status(302).redirect(fallback);
    }
    try {
      const result = await this.oauth.completeAuthorization(code, state, actor);
      return reply
        .status(302)
        .redirect(`/tenants/${encodeURIComponent(result.tenantId)}/domains?cloudflare=connected`);
    } catch {
      return reply.status(302).redirect(fallback);
    }
  }
}
