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
      tenantMembership: {
        findUnique: vi.fn().mockResolvedValue({
          id: membershipId,
          status: MembershipStatus.Active,
          roles: [
            {
              role: {
                permissions: [
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
                      permissions: [
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

  it("resolves service identity permissions through RolePermission instead of the legacy Role array", async () => {
    const tenantId = "255d43ba-43fd-49f7-8546-824760045ecd";
    const serviceIdentityId = "8c8d0ea9-e0b2-4c13-935f-7e04ec03f8ff";
    const roleFindMany = vi.fn().mockResolvedValue([
      {
        role: {
          permissions: [
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
});
