import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { UserStatus } from "@prisma/client";
import { TenantsService } from "./tenants.service";

const token = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLM";
const invitation = {
  id: "invitation-1", tenantId: "tenant-1", email: "alice@example.com",
  tokenHash: createHash("sha256").update(token).digest("hex"),
  roleIds: ["tenant-member"], expiresAt: new Date(Date.now() + 60_000),
  createdBy: "creator-1", tenant: { id: "tenant-1", name: "acme" },
};

function setup() {
  const tx = {
    tenantMembership: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({
        id: "membership-1", tenantId: "tenant-1", userId: "user-1", status: "Active",
        roles: [{ roleId: "tenant-member", role: { id: "tenant-member", name: "Member" } }],
        tenant: { id: "tenant-1", name: "acme" }, user: { id: "user-1", email: "alice@example.com" },
      }),
    },
    tenantOidcProvider: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    tenantInvitation: { delete: vi.fn() },
    auditLogEntry: { create: vi.fn() },
  };
  const prisma = {
    tenantInvitation: { findUnique: vi.fn().mockResolvedValue(invitation) },
    role: { findMany: vi.fn().mockResolvedValue([{ id: "tenant-member" }]) },
    $transaction: vi.fn(async (callback: (tx: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  const svc = new TenantsService(prisma as never, { sendTenantInvitation: vi.fn() } as never);
  const actor = { id: "user-1", email: "alice@example.com", displayName: "Alice", status: UserStatus.Active };
  return { svc, tx, prisma, actor };
}

describe("tenant invite activation invalidates OIDC grants transactionally", () => {
  it("disables stale SSO grants in the same transaction that accepts invitation", async () => {
    const f = setup();
    await f.svc.acceptInvitation({ token }, f.actor);
    expect(f.tx.tenantMembership.create).toHaveBeenCalledOnce();
    expect(f.tx.tenantOidcProvider.updateMany).toHaveBeenCalledWith({
      where: { tenantId: "tenant-1" },
      data: { enabled: false, status: "NeedsReconciliation", grantsReconciledAt: null },
    });
    expect(f.tx.tenantInvitation.delete).toHaveBeenCalledOnce();
  });
  it("a failed stale transition prevents acceptance and keeps invitation intact", async () => {
    const f = setup();
    f.tx.tenantOidcProvider.updateMany.mockRejectedValue(new Error("database write failed"));
    await expect(f.svc.acceptInvitation({ token }, f.actor)).rejects.toThrow("database write failed");
    expect(f.tx.tenantInvitation.delete).not.toHaveBeenCalled();
  });
});
