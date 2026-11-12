import { createHash } from "node:crypto";
import { ConflictException } from "@nestjs/common";
import { UserStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { TenantsService } from "./tenants.service";

const token = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLM";
const appId = "550e8400-e29b-41d4-a716-446655440000";
const invitation = {
  id: "invitation-1", tenantId: "tenant-1", email: "alice@example.com",
  tokenHash: createHash("sha256").update(token).digest("hex"),
  roleIds: ["sso-login"], nativeApplicationKeys: ["web"],
  appInvitationGrants: [{ oauthApplicationId: appId }],
  expiresAt: new Date(Date.now() + 60_000),
  createdBy: "creator-1", tenant: { id: "tenant-1", name: "acme" },
};
function fixture() {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    tenantMembership: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({
        id: "membership-1", tenantId: "tenant-1", userId: "user-1", status: "Active",
        roles: [{ role: { id: "sso-login", name: "SSO", permissions: [] } }],
        user: { id: "user-1", email: "alice@example.com", status: UserStatus.Active },
        nativeAppGrants: [], appGrants: [],
      }),
    },
    tenantAppClientGrant: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    tenantNativeAppGrant: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    tenantOidcProvider: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    tenantInvitation: { delete: vi.fn() },
    auditLogEntry: { create: vi.fn() },
  };
  const prisma = {
    role: { findMany: vi.fn().mockResolvedValue([{ id: "sso-login" }, { id: "tenant-admin" }]) },
    tenantInvitation: { findUnique: vi.fn().mockResolvedValue(invitation) },
    $transaction: vi.fn(async (callback: (tx: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  const service = new TenantsService(prisma as never, { sendTenantInvitation: vi.fn() } as never);
  const actor = { id: "user-1", email: "alice@example.com", displayName: "Alice", status: UserStatus.Active };
  return { tx, prisma, service, actor };
}

describe("#430 unified invitations remain transactional", () => {
  it("creates one membership with independent SSO role and Web and OAuth app grants", async () => {
    const f = fixture();
    await f.service.acceptInvitation({ token }, f.actor);
    expect(f.tx.tenantMembership.create).toHaveBeenCalledOnce();
    expect(f.tx.tenantMembership.create.mock.calls[0]?.[0] as unknown).toMatchObject({
      data: { roles: { create: [{ roleId: "sso-login" }] } },
    });
    expect(f.tx.tenantAppClientGrant.createMany).toHaveBeenCalledWith({
      data: [{ membershipId: "membership-1", tenantId: "tenant-1",
        oauthApplicationId: appId, createdBy: "creator-1", updatedBy: "creator-1" }],
      skipDuplicates: true,
    });
    expect(f.tx.tenantNativeAppGrant.createMany).toHaveBeenCalledWith({
      data: [{ membershipId: "membership-1", tenantId: "tenant-1",
        clientKey: "web", createdBy: "creator-1", updatedBy: "creator-1" }],
      skipDuplicates: true,
    });
    expect(f.tx.tenantOidcProvider.updateMany).toHaveBeenCalledWith({
      where: { tenantId: "tenant-1", status: { notIn: ["Disabling", "Disabled", "Deleted"] } },
      data: { enabled: false, status: "NeedsReconciliation", grantsReconciledAt: null },
    });
    expect(f.tx.tenantInvitation.delete).toHaveBeenCalledOnce();
    expect(f.tx.auditLogEntry.create).toHaveBeenCalledOnce();
  });

  it("accepts combined SSO application and ResourcePortal Admin role without a duplicate user identity", async () => {
    const f = fixture();
    f.prisma.tenantInvitation.findUnique.mockResolvedValueOnce({
      ...invitation, roleIds: ["sso-login", "tenant-admin"],
    });
    await f.service.acceptInvitation({ token }, f.actor);
    expect(f.tx.tenantMembership.create.mock.calls[0]?.[0] as unknown).toMatchObject({
      data: { userId: f.actor.id, roles: { create: [{ roleId: "sso-login" }, { roleId: "tenant-admin" }] } },
    });
    expect(f.tx.tenantAppClientGrant.createMany).toHaveBeenCalledOnce();
    expect(f.tx.tenantNativeAppGrant.createMany).toHaveBeenCalledOnce();
  });

  it("permits role-free member when no applications selected; membership alone remains RP-denied", async () => {
    const f = fixture();
    f.prisma.tenantInvitation.findUnique.mockResolvedValueOnce({
      ...invitation, roleIds: [], nativeApplicationKeys: [], appInvitationGrants: [],
    });
    await f.service.acceptInvitation({ token }, f.actor);
    expect(f.tx.tenantMembership.create.mock.calls[0]?.[0] as unknown).toMatchObject({
      data: { roles: { create: [] } },
    });
    expect(f.tx.tenantAppClientGrant.createMany).not.toHaveBeenCalled();
    expect(f.tx.tenantNativeAppGrant.createMany).not.toHaveBeenCalled();
  });

  it("does not overwrite a membership in the same tenant even for the same person", async () => {
    const f = fixture();
    f.tx.tenantMembership.findUnique.mockResolvedValueOnce({ id: "already-existing" });
    await expect(f.service.acceptInvitation({ token }, f.actor)).rejects.toBeInstanceOf(ConflictException);
    expect(f.tx.tenantMembership.create).not.toHaveBeenCalled();
  });

  it("rejects invalid native OIDC client keys before writes", async () => {
    const f = fixture();
    f.prisma.tenantInvitation.findUnique.mockResolvedValueOnce({
      ...invitation, nativeApplicationKeys: ["unknown-client"],
    });
    await expect(f.service.acceptInvitation({ token }, f.actor)).rejects.toThrow("Invalid invitation client keys");
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("rolls back acceptance when OIDC invalidation cannot commit", async () => {
    const f = fixture();
    f.tx.tenantOidcProvider.updateMany.mockRejectedValueOnce(new Error("database write failed"));
    await expect(f.service.acceptInvitation({ token }, f.actor)).rejects.toThrow("database write failed");
    expect(f.tx.tenantInvitation.delete).not.toHaveBeenCalled();
  });
});
