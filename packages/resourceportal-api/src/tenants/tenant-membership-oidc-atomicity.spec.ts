import { MembershipStatus, UserStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { TenantsService } from "./tenants.service";

const tenantId = "11111111-1111-4111-8111-111111111111";
const membershipId = "22222222-2222-4222-8222-222222222222";
const userId = "33333333-3333-4333-8333-333333333333";
const roleId = "tenant-viewer";
const tenant = { id: tenantId, name: "acme" };
const actor = { id: "actor-1", email: "owner@example.test", displayName: "Owner", status: UserStatus.Active };
const user = { id: userId, email: "member@example.test", displayName: "Member", status: UserStatus.Active };
const member = {
  id: membershipId, tenantId, userId, status: MembershipStatus.Suspended,
  user, roles: [{ roleId, role: { id: roleId, name: "Viewer", permissions: [] } }],
  groupMemberships: [], createdBy: actor.id, createdAt: new Date(),
};
const expectedInvalidation = {
  where: { tenantId },
  data: { enabled: false, status: "NeedsReconciliation", grantsReconciledAt: null },
};

function setup() {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    tenantMembership: {
      create: vi.fn().mockResolvedValue({ ...member, status: MembershipStatus.Active }),
      findFirst: vi.fn().mockResolvedValue(member),
      update: vi.fn().mockResolvedValue({ ...member, status: MembershipStatus.Active }),
      delete: vi.fn().mockResolvedValue(member),
    },
    tenantOidcProvider: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    auditLogEntry: { create: vi.fn().mockResolvedValue({}) },
    membershipRole: { deleteMany: vi.fn(), createMany: vi.fn() },
  };
  const prisma = {
    tenant: { findUnique: vi.fn().mockResolvedValue(tenant) },
    user: { findUnique: vi.fn().mockResolvedValue(user) },
    role: { findMany: vi.fn().mockResolvedValue([{ id: roleId }]) },
    tenantMembership: { findFirst: vi.fn().mockResolvedValue(member) },
    $transaction: vi.fn(async (callback: (tx: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  const service = new TenantsService(prisma as never, { sendTenantInvitation: vi.fn() } as never);
  return { tx, prisma, service };
}

describe("tenant membership OIDC invalidation is atomic with membership writes", () => {
  it("invalidates readiness within membership creation transaction before audit", async () => {
    const f = setup();
    await f.service.createMembership(tenantId, { userId, roleIds: [roleId] }, actor);
    expect(f.prisma.$transaction).toHaveBeenCalledOnce();
    expect(f.tx.tenantOidcProvider.updateMany).toHaveBeenCalledWith(expectedInvalidation);
    expect(f.tx.tenantMembership.create.mock.invocationCallOrder[0])
      .toBeLessThan(f.tx.tenantOidcProvider.updateMany.mock.invocationCallOrder[0]);
    expect(f.tx.tenantOidcProvider.updateMany.mock.invocationCallOrder[0])
      .toBeLessThan(f.tx.auditLogEntry.create.mock.invocationCallOrder[0]);
  });

  it("aborts creation and does not commit an audit when invalidation fails", async () => {
    const f = setup();
    f.tx.tenantOidcProvider.updateMany.mockRejectedValue(new Error("stale write failed"));
    await expect(f.service.createMembership(tenantId, { userId, roleIds: [roleId] }, actor))
      .rejects.toThrow("stale write failed");
    expect(f.tx.auditLogEntry.create).not.toHaveBeenCalled();
  });

  it("invalidates readiness atomically on suspended-to-active reactivation", async () => {
    const f = setup();
    await f.service.updateMembership(tenantId, membershipId, { status: MembershipStatus.Active }, actor);
    expect(f.prisma.$transaction).toHaveBeenCalledOnce();
    expect(f.tx.tenantMembership.update).toHaveBeenCalledOnce();
    expect(f.tx.tenantOidcProvider.updateMany).toHaveBeenCalledWith(expectedInvalidation);
    expect(f.tx.tenantMembership.update.mock.invocationCallOrder[0])
      .toBeLessThan(f.tx.tenantOidcProvider.updateMany.mock.invocationCallOrder[0]);
    expect(f.tx.tenantOidcProvider.updateMany.mock.invocationCallOrder[0])
      .toBeLessThan(f.tx.auditLogEntry.create.mock.invocationCallOrder[0]);
  });

  it("refuses reactivation when readiness invalidation fails", async () => {
    const f = setup();
    f.tx.tenantOidcProvider.updateMany.mockRejectedValue(new Error("cannot invalidate grants"));
    await expect(f.service.updateMembership(tenantId, membershipId, { status: MembershipStatus.Active }, actor))
      .rejects.toThrow("cannot invalidate grants");
    expect(f.tx.auditLogEntry.create).not.toHaveBeenCalled();
  });

  it("invalidates readiness inside deletion transaction", async () => {
    const f = setup();
    await f.service.deleteMembership(tenantId, membershipId, actor);
    expect(f.tx.tenantMembership.delete).toHaveBeenCalledOnce();
    expect(f.tx.tenantOidcProvider.updateMany).toHaveBeenCalledWith(expectedInvalidation);
    expect(f.tx.tenantOidcProvider.updateMany.mock.invocationCallOrder[0])
      .toBeLessThan(f.tx.auditLogEntry.create.mock.invocationCallOrder[0]);
  });
});
