import { ForbiddenException } from "@nestjs/common";
import { UserStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { TenantsService } from "./tenants.service";

const actor = { id: "11111111-1111-4111-8111-111111111111",
  email: "user@example.test", displayName: "User", status: UserStatus.Active };
const dto = { name: "personal", displayName: "Personal", contactEmail: actor.email };

function fixture(existingMembershipCount: number, owner: boolean) {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    tenantMembership: {
      count: vi.fn().mockResolvedValue(existingMembershipCount),
      findFirst: vi.fn().mockResolvedValue(owner ? { id: "existing-owner" } : null),
    },
    tenant: { create: vi.fn().mockResolvedValue({ id: "new-tenant" }) },
  };
  const prisma = { $transaction: vi.fn(async (fn: (tx: typeof tx) => Promise<unknown>) => fn(tx)) };
  return { tx, service: new TenantsService(prisma as never, {} as never) };
}

describe("#430 global tenant creation is not an implicit SSO entitlement", () => {
  it("refuses a tenant member with only sso-login and OAuth access", async () => {
    const { tx, service } = fixture(1, false);
    await expect(service.createTenant(dto, actor)).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(tx.tenantMembership.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        userId: actor.id, status: "Active", roles: { some: { roleId: "tenant-owner" } },
      }),
    }));
    expect(tx.tenant.create).not.toHaveBeenCalled();
  });

  it("allows a genuinely new user to create their first tenant", async () => {
    const { tx, service } = fixture(0, false);
    await expect(service.createTenant(dto, actor)).resolves.toEqual({ id: "new-tenant" });
    expect(tx.tenant.create).toHaveBeenCalledOnce();
    expect(tx.tenantMembership.findFirst).not.toHaveBeenCalled();
  });

  it("allows only an existing active tenant owner to create an additional tenant", async () => {
    const { tx, service } = fixture(2, true);
    await expect(service.createTenant(dto, actor)).resolves.toEqual({ id: "new-tenant" });
    expect(tx.tenant.create).toHaveBeenCalledOnce();
  });
});
