import { Controller, Get, UseGuards } from "@nestjs/common";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Read-only infrastructure oversight. Tenant grants and user identities are
 * intentionally excluded: platform administrators don't inherit tenant RBAC.
 */
@Controller("platform/tenant-oidc")
@UseGuards(PlatformAdminGuard)
export class PlatformTenantOidcController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list() {
    const providers = await this.prisma.tenantOidcProvider.findMany({
      orderBy: { createdAt: "asc" },
      select: {
        tenantId: true,
        status: true,
        enabled: true,
        createdAt: true,
        updatedAt: true,
        lastErrorCode: true,
        grantsReconciledAt: true,
      },
    });
    return providers;
  }
}
