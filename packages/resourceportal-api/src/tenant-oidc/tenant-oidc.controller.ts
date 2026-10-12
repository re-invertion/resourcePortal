import {
  Controller, Delete, ForbiddenException, Get, Param, ParseUUIDPipe, Post,
} from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { RequirePermissions } from "../auth/require-permissions.decorator";
import type { AuthenticatedUser } from "../auth/types";
import { TenantOidcAuditService } from "./tenant-oidc-audit.service";
import { TenantOidcService } from "./tenant-oidc.service";

@Controller("tenants/:tenantId/oidc-provider")
export class TenantOidcController {
  constructor(
    private readonly service: TenantOidcService,
    private readonly audit: TenantOidcAuditService,
  ) {}

  @Get()
  @RequirePermissions("oauth_application.read")
  get(@Param("tenantId", ParseUUIDPipe) tenantId: string) {
    return this.service.get(tenantId);
  }

  @Post("provision")
  @RequirePermissions("oauth_application.create")
  provision(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.mutate(tenantId, actor, "provision", () => this.service.provision(tenantId));
  }

  @Post("activate")
  @RequirePermissions("oauth_application.update")
  activate(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.mutate(tenantId, actor, "activate", () => this.service.activate(tenantId));
  }

  @Post("disable")
  @RequirePermissions("oauth_application.update")
  disable(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.mutate(tenantId, actor, "disable", () => this.service.disable(tenantId));
  }

  @Delete()
  @RequirePermissions("oauth_application.delete")
  delete(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.mutate(tenantId, actor, "delete", () => this.service.delete(tenantId));
  }

  @Post("reconcile-grants")
  @RequirePermissions("oauth_application.update")
  reconcileGrants(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.mutate(
      tenantId,
      actor,
      "reconcile_grants",
      () => this.service.reconcileGrants(tenantId),
    );
  }

  private async mutate<T>(
    tenantId: string,
    actor: AuthenticatedUser | undefined,
    operation: string,
    work: () => Promise<T>,
  ): Promise<T> {
    // Machine tokens are not authorized to administer provider infrastructure.
    if (!actor?.id) throw new ForbiddenException("Human tenant administrator required");
    try {
      const result = await work();
      await this.audit.record(tenantId, actor, operation, "Success");
      return result;
    } catch (error) {
      // Preserve the original failure, but attempt an auditable failure event.
      await this.audit.record(tenantId, actor, operation, "Failed").catch(() => undefined);
      throw error;
    }
  }
}
