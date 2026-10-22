import { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { MembershipStatus, UserStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../prisma/prisma.service";
import { TenantContextGuard } from "./tenant-context.guard";

function fixture(authenticatedIdpId?: string | null) {
  const tenantId = "tenant-1";
  const request = {
    params: { tenantId },
    user: {
      id: "user-1", email: "u@example.com", status: UserStatus.Active,
      authenticatedIdpId,
    },
  };
  const identityProvider = { findFirst: vi.fn().mockResolvedValue({ id: "tenant-idp" }) };
  const prisma = {
    tenantMembership: { findUnique: vi.fn().mockResolvedValue({
      id: "membership-1", status: MembershipStatus.Active,
      roles: [], groupMemberships: [],
    }) },
    tenantAuthPolicy: { findUnique: vi.fn().mockResolvedValue({
      requireTenantIdentityProvider: true,
    }) },
    identityProvider,
  };
  const guard = new TenantContextGuard({
    getAllAndOverride: vi.fn().mockReturnValue(undefined),
  } as unknown as Reflector, prisma as unknown as PrismaService);
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => function handler() {},
    getClass: () => class TenantController {},
  } as unknown as ExecutionContext;
  return { guard, context, request, prisma };
}

describe("tenant IDP requirement is enforced on every tenant API request (#238)", () => {
  it("denies platform-only bearer or legacy session with no signed provider provenance", async () => {
    for (const idpId of [undefined, null]) {
      const f = fixture(idpId);
      await expect(f.guard.canActivate(f.context)).rejects.toThrow(
        "requires a verified tenant identity provider",
      );
      expect(f.prisma.identityProvider.findFirst).not.toHaveBeenCalled();
    }
  });
  it("rejects a signed provider from a different tenant or disabled provider", async () => {
    const f = fixture("zitadel-other-tenant-idp");
    f.prisma.identityProvider.findFirst.mockResolvedValue(null);
    await expect(f.guard.canActivate(f.context)).rejects.toThrow(
      "Login did not use an enabled identity provider",
    );
    expect(f.prisma.identityProvider.findFirst).toHaveBeenCalledWith({
      where: {
        scope: "Tenant", tenantId: "tenant-1", enabled: true,
        zitadelIdentityProviderId: "zitadel-other-tenant-idp",
      },
      select: { id: true },
    });
  });
  it("allows valid tenant IDP provenance and active tenant membership", async () => {
    const f = fixture("zitadel-tenant-idp");
    await expect(f.guard.canActivate(f.context)).resolves.toBe(true);
    expect(f.request).toMatchObject({
      tenantContext: {
        tenantId: "tenant-1", membershipId: "membership-1", permissions: [],
      },
    });
  });
  it("denies a platform session when allowPlatformLogin=false even without requireTenantIdentityProvider", async () => {
    const f = fixture(null);
    f.prisma.tenantAuthPolicy.findUnique.mockResolvedValue({
      requireTenantIdentityProvider: false,
      allowPlatformLogin: false,
    });
    await expect(f.guard.canActivate(f.context)).rejects.toThrow(
      "requires a verified tenant identity provider",
    );
    expect(f.prisma.identityProvider.findFirst).not.toHaveBeenCalled();
  });
  it("permits enabled tenant provider provenance with allowPlatformLogin=false", async () => {
    const f = fixture("zitadel-tenant-idp");
    f.prisma.tenantAuthPolicy.findUnique.mockResolvedValue({
      requireTenantIdentityProvider: false,
      allowPlatformLogin: false,
    });
    await expect(f.guard.canActivate(f.context)).resolves.toBe(true);
    expect(f.prisma.identityProvider.findFirst).toHaveBeenCalledOnce();
  });
  it("enforces the disabled or foreign-provider check for allowPlatformLogin=false", async () => {
    const f = fixture("zitadel-foreign-idp");
    f.prisma.tenantAuthPolicy.findUnique.mockResolvedValue({
      requireTenantIdentityProvider: false,
      allowPlatformLogin: false,
    });
    f.prisma.identityProvider.findFirst.mockResolvedValue(null);
    await expect(f.guard.canActivate(f.context)).rejects.toThrow(
      "Login did not use an enabled identity provider",
    );
  });
  it("does not reapply retired inbound policies after native-only cutover", async () => {
    const f = fixture(null);
    f.prisma.tenantAuthPolicy.findUnique.mockResolvedValue({
      requireTenantIdentityProvider: true,
      allowPlatformLogin: false,
    });
    const nativeOnlyGuard = new TenantContextGuard(
      { getAllAndOverride: vi.fn().mockReturnValue(undefined) } as unknown as Reflector,
      f.prisma as unknown as PrismaService,
      { get: vi.fn().mockReturnValue("true") } as never,
    );
    await expect(nativeOnlyGuard.canActivate(f.context)).resolves.toBe(true);
    expect(f.prisma.identityProvider.findFirst).not.toHaveBeenCalled();
  });
  it("rejects tenant IdP provenance when the tenant disables incoming tenant providers", async () => {
    const f = fixture("zitadel-tenant-idp");
    f.prisma.tenantAuthPolicy.findUnique.mockResolvedValue({
      requireTenantIdentityProvider: false,
      allowPlatformLogin: true,
      allowTenantIdentityProviders: false,
    });
    f.prisma.identityProvider.findFirst.mockResolvedValue(null);
    await expect(f.guard.canActivate(f.context)).rejects.toThrow(
      "Tenant identity provider login is disabled",
    );
    expect(f.prisma.identityProvider.findFirst).toHaveBeenCalledWith({
      where: {
        scope: "Platform", tenantId: null, enabled: true,
        zitadelIdentityProviderId: "zitadel-tenant-idp",
      },
      select: { id: true },
    });
  });
  it("permits a verified platform provider while tenant IdPs are disabled", async () => {
    const f = fixture("zitadel-platform-idp");
    f.prisma.tenantAuthPolicy.findUnique.mockResolvedValue({
      requireTenantIdentityProvider: false,
      allowPlatformLogin: true,
      allowTenantIdentityProviders: false,
    });
    await expect(f.guard.canActivate(f.context)).resolves.toBe(true);
    expect(f.prisma.identityProvider.findFirst).toHaveBeenCalledWith({
      where: {
        scope: "Platform", tenantId: null, enabled: true,
        zitadelIdentityProviderId: "zitadel-platform-idp",
      },
      select: { id: true },
    });
  });
  it("permits native platform login when tenant IdPs are disabled but platform login is allowed", async () => {
    const f = fixture(null);
    f.prisma.tenantAuthPolicy.findUnique.mockResolvedValue({
      requireTenantIdentityProvider: false,
      allowPlatformLogin: true,
      allowTenantIdentityProviders: false,
    });
    await expect(f.guard.canActivate(f.context)).resolves.toBe(true);
    expect(f.prisma.identityProvider.findFirst).not.toHaveBeenCalled();
  });
  it("fails closed for contradictory provider policy flags", async () => {
    const f = fixture("zitadel-tenant-idp");
    f.prisma.tenantAuthPolicy.findUnique.mockResolvedValue({
      requireTenantIdentityProvider: true,
      allowPlatformLogin: false,
      allowTenantIdentityProviders: false,
    });
    await expect(f.guard.canActivate(f.context)).rejects.toThrow(
      "Tenant identity provider login is disabled",
    );
    expect(f.prisma.identityProvider.findFirst).not.toHaveBeenCalled();
  });
  it("remains compatible with tenants that do not require their own provider", async () => {
    const f = fixture();
    f.prisma.tenantAuthPolicy.findUnique.mockResolvedValue({
      requireTenantIdentityProvider: false,
    });
    await expect(f.guard.canActivate(f.context)).resolves.toBe(true);
  });
});
