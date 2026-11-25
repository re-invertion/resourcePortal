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
  where: { tenantId, status: { notIn: ["Disabling", "Disabled", "Deleted"] } },
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

  it("revokes suspended membership while holding the tenant lock, before changing its status", async () => {
    const f = setup();
    const revoke = vi.fn().mockResolvedValue(undefined);
    const svc = new TenantsService(f.prisma as never, {} as never,
      { revokeGrantBeforeMembershipRemoval: revoke } as never);
    await svc.updateMembership(tenantId, membershipId, { status: MembershipStatus.Suspended }, actor);
    expect(revoke).toHaveBeenCalledWith(tenantId, userId, f.tx);
    expect(f.tx.$queryRaw.mock.invocationCallOrder[0])
      .toBeLessThan(revoke.mock.invocationCallOrder[0]);
    expect(revoke.mock.invocationCallOrder[0])
      .toBeLessThan(f.tx.tenantMembership.update.mock.invocationCallOrder[0]);
  });

  it("revokes deleted membership while holding the tenant lock, before deleting membership", async () => {
    const f = setup();
    const revoke = vi.fn().mockResolvedValue(undefined);
    const svc = new TenantsService(f.prisma as never, {} as never,
      { revokeGrantBeforeMembershipRemoval: revoke } as never);
    await svc.deleteMembership(tenantId, membershipId, actor);
    expect(revoke).toHaveBeenCalledWith(tenantId, userId, f.tx);
    expect(f.tx.$queryRaw.mock.invocationCallOrder[0])
      .toBeLessThan(revoke.mock.invocationCallOrder[0]);
    expect(revoke.mock.invocationCallOrder[0])
      .toBeLessThan(f.tx.tenantMembership.delete.mock.invocationCallOrder[0]);
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

const selfOAuthId = "44444444-4444-4444-8444-444444444444";

function setupSelfMember(owner = false, status = MembershipStatus.Active) {
  const f = setup();
  const owned = {
    ...member,
    status,
    roles: owner
      ? [{ roleId: "tenant-owner", role: { id: "tenant-owner", name: "Owner", permissions: ["*"] } }]
      : member.roles,
    appGrants: [{ oauthApplicationId: selfOAuthId, enabled: true }],
    nativeAppGrants: [{ clientKey: "web", enabled: true }],
  };
  f.prisma.tenantMembership.findFirst.mockResolvedValue(owned as never);
  f.tx.tenantMembership.findFirst.mockResolvedValue(owned as never);
  f.tx.tenantMembership.update.mockResolvedValue(owned as never);
  Object.assign(f.prisma.tenantMembership, {
    findUnique: vi.fn().mockResolvedValue({
      status: owned.status,
      roles: owned.roles.map(({ roleId }) => ({ roleId })),
    }),
  });
  const oauthGrants = {
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    upsert: vi.fn().mockResolvedValue({}),
  };
  const nativeGrants = {
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    upsert: vi.fn().mockResolvedValue({}),
  };
  Object.assign(f.tx, {
    tenantAppClientGrant: oauthGrants,
    tenantNativeAppGrant: nativeGrants,
    oAuthApplication: { findMany: vi.fn().mockResolvedValue([]) },
  });
  return {
    ...f, owned, oauthGrants, nativeGrants,
    selfActor: { ...actor, id: userId },
  };
}

describe("tenant membership self-management permission boundary", () => {
  it("lets an active Owner manage their own native application grants with an audit", async () => {
    const f = setupSelfMember(true);
    await f.service.updateMembership(tenantId, membershipId,
      { nativeApplicationKeys: ["web", "cli"] }, f.selfActor);
    expect(f.nativeGrants.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { membershipId_clientKey: { membershipId, clientKey: "cli" } },
    }));
    expect(f.tx.auditLogEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        actor: userId, action: "membership.update", resourceId: membershipId,
      }),
    }));
  });

  it("permits a non-Owner to revoke their own existing grants or reduce direct roles", async () => {
    const f = setupSelfMember();
    await f.service.updateMembership(tenantId, membershipId,
      { roleIds: [], oauthApplicationIds: [], nativeApplicationKeys: [] }, f.selfActor);
    expect(f.oauthGrants.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ membershipId, tenantId, enabled: true }),
      data: { enabled: false, updatedBy: userId },
    }));
    expect(f.nativeGrants.updateMany).toHaveBeenCalled();
    expect(f.tx.membershipRole.deleteMany).toHaveBeenCalledWith({
      where: { membershipId },
    });
    expect(f.tx.auditLogEntry.create).toHaveBeenCalledOnce();
  });

  it("rejects self-enabling a new RP client grant with no write", async () => {
    const f = setupSelfMember();
    await expect(f.service.updateMembership(tenantId, membershipId,
      { nativeApplicationKeys: ["web", "cli"] }, f.selfActor))
      .rejects.toThrow("You cannot grant yourself additional roles");
    expect(f.nativeGrants.upsert).not.toHaveBeenCalled();
    expect(f.tx.tenantMembership.update).not.toHaveBeenCalled();
    expect(f.tx.auditLogEntry.create).not.toHaveBeenCalled();
  });

  it("rejects self-granting a new tenant OAuth application with no write", async () => {
    const f = setupSelfMember();
    await expect(f.service.updateMembership(tenantId, membershipId,
      { oauthApplicationIds: ["55555555-5555-4555-8555-555555555555"] }, f.selfActor))
      .rejects.toThrow("You cannot grant yourself additional roles");
    expect(f.oauthGrants.upsert).not.toHaveBeenCalled();
    expect(f.tx.tenantMembership.update).not.toHaveBeenCalled();
  });

  it("rejects self-promotion to a new role even with membership.update", async () => {
    const f = setupSelfMember();
    f.prisma.role.findMany.mockResolvedValue([{ id: roleId }, { id: "tenant-admin" }] as never);
    await expect(f.service.updateMembership(tenantId, membershipId,
      { roleIds: [roleId, "tenant-admin"] }, f.selfActor))
      .rejects.toThrow("You cannot grant yourself additional roles");
    expect(f.tx.membershipRole.deleteMany).not.toHaveBeenCalled();
    expect(f.tx.auditLogEntry.create).not.toHaveBeenCalled();
  });

  it("rejects self-reactivation of a suspended member", async () => {
    const f = setupSelfMember(false, MembershipStatus.Suspended);
    await expect(f.service.updateMembership(tenantId, membershipId,
      { status: MembershipStatus.Active }, f.selfActor))
      .rejects.toThrow("You cannot grant yourself additional roles");
    expect(f.tx.tenantMembership.update).not.toHaveBeenCalled();
  });

  it("checks the tenant-locked membership rather than an earlier Owner snapshot", async () => {
    const f = setupSelfMember();
    const earlierOwner = {
      ...f.owned,
      roles: [{ roleId: "tenant-owner", role: { id: "tenant-owner", name: "Owner", permissions: ["*"] } }],
    };
    f.prisma.tenantMembership.findFirst.mockResolvedValue(earlierOwner as never);
    Object.assign(f.prisma.tenantMembership, {
      findUnique: vi.fn().mockResolvedValue({
        status: MembershipStatus.Active, roles: [{ roleId: "tenant-owner" }],
      }),
    });
    await expect(f.service.updateMembership(tenantId, membershipId,
      { nativeApplicationKeys: ["web", "cli"] }, f.selfActor))
      .rejects.toThrow("You cannot grant yourself additional roles");
    expect(f.nativeGrants.upsert).not.toHaveBeenCalled();
    expect(f.tx.auditLogEntry.create).not.toHaveBeenCalled();
  });

  it("preserves the last active Owner when self-suspending", async () => {
    const f = setupSelfMember(true);
    Object.assign(f.tx.tenantMembership, {
      count: vi.fn().mockResolvedValue(0),
    });
    await expect(f.service.updateMembership(tenantId, membershipId,
      { status: MembershipStatus.Suspended }, f.selfActor))
      .rejects.toThrow("TenantLastOwner");
    expect(f.tx.tenantMembership.update).not.toHaveBeenCalled();
    expect(f.tx.auditLogEntry.create).not.toHaveBeenCalled();
  });
});
