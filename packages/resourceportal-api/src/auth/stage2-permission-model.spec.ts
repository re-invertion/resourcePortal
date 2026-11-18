import { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { MembershipStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextGuard } from "./tenant-context.guard";

function contextFor(request: Record<string, unknown>) {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => function handler() {},
    getClass: () => class TestController {},
  } as unknown as ExecutionContext;
}

describe("Stage 2 Permission model", () => {
  it("resolves membership permissions through Permission entities for direct and group roles", async () => {
    const tenantId = "255d43ba-43fd-49f7-8546-824760045ecd";
    const membershipId = "158e191e-967a-4fe9-9480-3ea28010a714";
    const request = {
      params: { tenantId },
      user: { id: "2694b58e-578d-4360-a3e1-eb907320b873" },
    };
    const prisma = {
      tenantAuthPolicy: { findUnique: vi.fn().mockResolvedValue(null) },
      tenantMembership: {
        findUnique: vi.fn().mockResolvedValue({
          id: membershipId,
          status: MembershipStatus.Active,
          roles: [
            {
              role: {
                permissionBindings: [
                  { permission: { id: "tenant.read" } },
                  { permission: { id: "appgroup.read" } },
                ],
              },
            },
          ],
          groupMemberships: [
            {
              group: {
                roles: [
                  {
                    role: {
                      permissionBindings: [
                        { permission: { id: "group.read" } },
                        { permission: { id: "appgroup.read" } },
                      ],
                    },
                  },
                ],
              },
            },
          ],
        }),
      },
    } as unknown as PrismaService;
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValue(["tenant.read"]),
    } as unknown as Reflector;
    const guard = new TenantContextGuard(reflector, prisma);

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);

    expect(request).toMatchObject({
      tenantContext: {
        tenantId,
        membershipId,
        permissions: ["tenant.read", "appgroup.read", "group.read"],
      },
    });
  });

  it("rejects zero-permission tenant memberships even on legacy routes with no explicit @RequirePermissions", async () => {
    const tenantId = "255d43ba-43fd-49f7-8546-824760045ecd";
    const userId = "2694b58e-578d-4360-a3e1-eb907320b873";
    const request = { params: { tenantId }, user: { id: userId } };
    const memberLookup = vi.fn().mockResolvedValue({
      id: "158e191e-967a-4fe9-9480-3ea28010a714",
      status: MembershipStatus.Active,
      roles: [{ role: { permissionBindings: [] } }],
      groupMemberships: [],
    });
    const prisma = {
      tenantAuthPolicy: { findUnique: vi.fn().mockResolvedValue(null) },
      tenantMembership: { findUnique: memberLookup },
    } as unknown as PrismaService;
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValue(undefined),
    } as unknown as Reflector;
    const guard = new TenantContextGuard(reflector, prisma);

    await expect(guard.canActivate(contextFor(request))).rejects.toThrow(
      "No tenant permissions assigned",
    );
    expect(memberLookup).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId_tenantId: { userId, tenantId } },
    }));
  });

  it("allows genuinely authorized RP members on legacy routes, including inherited group permissions", async () => {
    const tenantId = "255d43ba-43fd-49f7-8546-824760045ecd";
    const prisma = {
      tenantAuthPolicy: { findUnique: vi.fn().mockResolvedValue(null) },
      tenantMembership: {
        findUnique: vi.fn().mockResolvedValue({
          id: "158e191e-967a-4fe9-9480-3ea28010a714",
          status: MembershipStatus.Active,
          roles: [{ role: { permissionBindings: [] } }],
          groupMemberships: [{
            group: {
              roles: [{
                role: { permissionBindings: [{ permission: { id: "billing.read" } }] },
              }],
            },
          }],
        }),
      },
    } as unknown as PrismaService;
    const reflector = { getAllAndOverride: vi.fn().mockReturnValue(undefined) } as unknown as Reflector;
    const guard = new TenantContextGuard(reflector, prisma);
    const request = {
      params: { tenantId },
      user: { id: "2694b58e-578d-4360-a3e1-eb907320b873" },
    };
    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request).toMatchObject({
      tenantContext: { permissions: ["billing.read"] },
    });
  });

  it("never treats the system sso-login role as RP permissions even if bindings are misconfigured", async () => {
    const tenantId = "255d43ba-43fd-49f7-8546-824760045ecd";
    const prisma = {
      tenantMembership: { findUnique: vi.fn().mockResolvedValue({
        id: "158e191e-967a-4fe9-9480-3ea28010a714",
        status: MembershipStatus.Active,
        roles: [{ role: { id: "sso-login", permissionBindings: [{ permission: { id: "tenant.read" } }] } }],
        groupMemberships: [],
      }) },
      tenantAuthPolicy: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const reflector = { getAllAndOverride: vi.fn().mockReturnValue(["tenant.read"]) } as unknown as Reflector;
    const guard = new TenantContextGuard(reflector, prisma);
    await expect(guard.canActivate(contextFor({
      params: { tenantId }, user: { id: "2694b58e-578d-4360-a3e1-eb907320b873" },
    }))).rejects.toThrow("No tenant permissions assigned");
  });

  it("SSO-only membership never bypasses RP management, even with app grants", async () => {
    const tenantId = "255d43ba-43fd-49f7-8546-824760045ecd";
    const prisma = {
      tenantMembership: {
        findUnique: vi.fn().mockResolvedValue({
          id: "158e191e-967a-4fe9-9480-3ea28010a714",
          status: MembershipStatus.Active,
          roles: [{ role: { permissionBindings: [] } }],
          groupMemberships: [],
          appGrants: [{ id: "external-grant" }],
          nativeAppGrants: [{ clientKey: "web" }],
        }),
      },
      tenantAuthPolicy: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const reflector = { getAllAndOverride: vi.fn().mockReturnValue(undefined) } as unknown as Reflector;
    const guard = new TenantContextGuard(reflector, prisma);
    await expect(guard.canActivate(contextFor({
      params: { tenantId }, user: { id: "2694b58e-578d-4360-a3e1-eb907320b873" },
    }))).rejects.toThrow("No tenant permissions assigned");
  });

  it("existing application grants cannot prevent legitimate group-based RP permissions", async () => {
    const tenantId = "255d43ba-43fd-49f7-8546-824760045ecd";
    const request = { params: { tenantId }, user: { id: "2694b58e-578d-4360-a3e1-eb907320b873" } };
    const prisma = {
      tenantMembership: { findUnique: vi.fn().mockResolvedValue({
        id: "158e191e-967a-4fe9-9480-3ea28010a714",
        status: MembershipStatus.Active,
        appConsumer: { membershipId: "legacy-app-marker" },
        roles: [{ role: { permissionBindings: [] } }],
        groupMemberships: [{
          group: { roles: [{ role: { permissionBindings: [{ permission: { id: "tenant.read" } }] } }] },
        }],
      }) },
      tenantAuthPolicy: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const reflector = { getAllAndOverride: vi.fn().mockReturnValue(["tenant.read"]) } as unknown as Reflector;
    const guard = new TenantContextGuard(reflector, prisma);
    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request).toMatchObject({ tenantContext: { permissions: ["tenant.read"] } });
  });

  it("resolves service identity permissions through RolePermission instead of the legacy Role array", async () => {
    const tenantId = "255d43ba-43fd-49f7-8546-824760045ecd";
    const serviceIdentityId = "8c8d0ea9-e0b2-4c13-935f-7e04ec03f8ff";
    const roleFindMany = vi.fn().mockResolvedValue([
      {
        role: {
          permissionBindings: [
            { permission: { id: "tenant.read" } },
            { permission: { id: "appgroup.read" } },
          ],
        },
      },
    ]);
    const legacyQuery = vi.fn().mockResolvedValue([
      { permissions: ["tenant.read", "appgroup.read"] },
    ]);
    const request = {
      params: { tenantId },
      serviceIdentity: {
        id: serviceIdentityId,
        tenantId,
        status: "Active",
      },
    };
    const prisma = {
      serviceIdentityRole: { findMany: roleFindMany },
      $queryRaw: legacyQuery,
    } as unknown as PrismaService;
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValue(["tenant.read"]),
    } as unknown as Reflector;
    const guard = new TenantContextGuard(reflector, prisma);

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);

    expect(roleFindMany).toHaveBeenCalledTimes(1);
    expect(legacyQuery).not.toHaveBeenCalled();
    expect(request).toMatchObject({
      tenantContext: {
        tenantId,
        serviceIdentityId,
        permissions: ["tenant.read", "appgroup.read"],
      },
    });
  });

  it("does not let a platform administrator bypass tenant membership", async () => {
    const tenantId = "255d43ba-43fd-49f7-8546-824760045ecd";
    const userId = "2694b58e-578d-4360-a3e1-eb907320b873";
    const request = { params: { tenantId }, user: { id: userId } };
    const membershipLookup = vi.fn().mockResolvedValue(null);
    const prisma = {
      tenantMembership: { findUnique: membershipLookup },
    } as unknown as PrismaService;
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValue(["billing.read"]),
    } as unknown as Reflector;
    const guard = new TenantContextGuard(reflector, prisma);

    await expect(guard.canActivate(contextFor(request))).rejects.toThrow(
      "Active tenant membership is required",
    );

    expect(membershipLookup).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_tenantId: { userId, tenantId } },
      }),
    );
    expect(request).not.toHaveProperty("tenantContext");
  });

});
