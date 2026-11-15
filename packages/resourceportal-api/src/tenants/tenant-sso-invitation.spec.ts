import { ConflictException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { TenantsService } from "./tenants.service";

const tenantId = "11111111-1111-4111-8111-111111111111";
const creatorId = "22222222-2222-4222-8222-222222222222";
const appA = "33333333-3333-4333-8333-333333333333";
const appB = "44444444-4444-4444-8444-444444444444";
const email = "new-person@example.com";
const actor = { id: creatorId, email: "owner@example.com", displayName: "Owner" };

function fixture() {
  const created = {
    id: "55555555-5555-4555-8555-555555555555",
    tenantId, email, roleIds: ["sso-login"], nativeApplicationKeys: [],
    tokenHash: "hash", expiresAt: new Date(Date.now() + 86_400_000),
    createdAt: new Date(), createdBy: creatorId, lastSentAt: new Date(),
  };
  const tx = {
    tenantInvitation: {
      create: vi.fn().mockImplementation(async ({ data }: { data: {
        appInvitationGrants?: { create: Array<{ oauthApplicationId: string }> };
      } }) => ({
        ...created,
        appInvitationGrants: data.appInvitationGrants?.create ?? [],
      })),
    },
    auditLogEntry: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    tenant: { findUnique: vi.fn().mockResolvedValue({ id: tenantId, name: "Home" }) },
    role: { findMany: vi.fn().mockResolvedValue([{ id: "sso-login" }]) },
    oAuthApplication: { findMany: vi.fn().mockResolvedValue([{ id: appA }]) },
    tenantMembership: { findFirst: vi.fn().mockResolvedValue(null) },
    tenantInvitation: {
      findMany: vi.fn().mockResolvedValue([{
        ...created, appInvitationGrants: [{ oauthApplicationId: appA }],
      }]),
    },
    $transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  const mail = { sendTenantInvitation: vi.fn().mockResolvedValue({ attempted: false, sent: false, reason: "SMTP is disabled" }) };
  const service = new TenantsService(prisma as never, mail as never);
  return { created, tx, prisma, mail, service };
}

describe("tenant SSO-only invitations (#458)", () => {
  it("creates exactly one OAuth grant using valid nested Prisma fields, no RP Web/CLI grant", async () => {
    const f = fixture();
    const result = await f.service.createInvitation(tenantId, {
      email, roleIds: ["sso-login"], nativeApplicationKeys: [], oauthApplicationIds: [appA],
    }, actor as never);

    const data = f.tx.tenantInvitation.create.mock.calls[0]?.[0].data;
    expect(data.tenantId).toBe(tenantId);
    expect(data.roleIds).toEqual(["sso-login"]);
    expect(data.nativeApplicationKeys).toEqual([]);
    // Prisma's CreateWithoutInvitationInput carries the composite parent
    // (invitationId, tenantId) itself. An extra tenantId is invalid at runtime.
    expect(data.appInvitationGrants).toEqual({ create: [{ oauthApplicationId: appA }] });
    expect(f.tx.auditLogEntry.create).toHaveBeenCalledOnce();
    expect(f.prisma.$transaction).toHaveBeenCalledOnce();
    expect(f.mail.sendTenantInvitation).toHaveBeenCalledOnce();
    expect(typeof result.token).toBe("string");
    expect(result.emailDelivery.sent).toBe(false);
    expect(result.oauthApplicationIds).toEqual([appA]);
  });

  it("lists pending exact-client application grants with no native application", async () => {
    const f = fixture();
    const rows = await f.service.listInvitations(tenantId);
    expect(f.prisma.tenantInvitation.findMany).toHaveBeenCalledWith({
      where: { tenantId }, orderBy: { createdAt: "desc" },
      include: { appInvitationGrants: { select: { oauthApplicationId: true } } },
    });
    expect(rows[0]).toMatchObject({
      roleIds: ["sso-login"], nativeApplicationKeys: [], oauthApplicationIds: [appA],
    });
  });

  it("supports multiple tenant-scoped OAuth grants without granting RP clients", async () => {
    const f = fixture();
    f.prisma.oAuthApplication.findMany.mockResolvedValue([{ id: appA }, { id: appB }]);
    await f.service.createInvitation(tenantId, {
      email, roleIds: ["sso-login"], nativeApplicationKeys: [], oauthApplicationIds: [appA, appB],
    }, actor as never);
    expect(f.tx.tenantInvitation.create.mock.calls[0]?.[0].data.appInvitationGrants).toEqual({
      create: [{ oauthApplicationId: appA }, { oauthApplicationId: appB }],
    });
  });

  it("does not create any OAuth grant when the invite contains only native permissions", async () => {
    const f = fixture();
    await f.service.createInvitation(tenantId, {
      email, roleIds: ["sso-login"], nativeApplicationKeys: ["web"], oauthApplicationIds: [],
    }, actor as never);
    const data = f.tx.tenantInvitation.create.mock.calls[0]?.[0].data;
    expect(data.appInvitationGrants).toBeUndefined();
    expect(data.nativeApplicationKeys).toEqual(["web"]);
  });

  it("rejects a foreign-tenant app before opening the transaction", async () => {
    const f = fixture();
    f.prisma.oAuthApplication.findMany.mockResolvedValue([]);
    await expect(f.service.createInvitation(tenantId, {
      email, roleIds: ["sso-login"], nativeApplicationKeys: [], oauthApplicationIds: [appA],
    }, actor as never)).rejects.toBeInstanceOf(NotFoundException);
    expect(f.prisma.oAuthApplication.findMany).toHaveBeenCalledWith({
      where: { tenantId, id: { in: [appA] } }, select: { id: true },
    });
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("returns 409 for an existing membership without writing an invitation", async () => {
    const f = fixture();
    f.prisma.tenantMembership.findFirst.mockResolvedValue({ status: "Active" });
    await expect(f.service.createInvitation(tenantId, {
      email, roleIds: ["sso-login"], oauthApplicationIds: [appA],
    }, actor as never)).rejects.toBeInstanceOf(ConflictException);
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("maps a database duplicate-invite collision to HTTP 409", async () => {
    const f = fixture();
    f.tx.tenantInvitation.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed", { code: "P2002", clientVersion: "6.12.0" },
    ));
    await expect(f.service.createInvitation(tenantId, {
      email, roleIds: ["sso-login"], oauthApplicationIds: [appA],
    }, actor as never)).rejects.toBeInstanceOf(ConflictException);
    expect(f.mail.sendTenantInvitation).not.toHaveBeenCalled();
  });

  it("never sends email if the audit or grant transaction fails", async () => {
    const f = fixture();
    f.tx.auditLogEntry.create.mockRejectedValue(new Error("DB write failed"));
    await expect(f.service.createInvitation(tenantId, {
      email, roleIds: ["sso-login"], oauthApplicationIds: [appA],
    }, actor as never)).rejects.toThrow();
    expect(f.mail.sendTenantInvitation).not.toHaveBeenCalled();
  });

  it("returns the durable invitation token when email delivery throws after commit", async () => {
    const f = fixture();
    f.mail.sendTenantInvitation.mockRejectedValue(new Error("SMTP or settings database unavailable"));
    const result = await f.service.createInvitation(tenantId, {
      email, roleIds: ["sso-login"], oauthApplicationIds: [appA],
    }, actor as never);
    expect(f.prisma.$transaction).toHaveBeenCalledOnce();
    expect(typeof result.token).toBe("string");
    expect(result.emailDelivery.sent).toBe(false);
    expect(result.emailDelivery.reason).not.toContain("SMTP or settings database unavailable");
  });
});
