import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { UserStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { AppConsumersService } from "./app-consumers.service";

const tenantId = "11111111-1111-4111-8111-111111111111";
const membershipId = "22222222-2222-4222-8222-222222222222";
const appId = "33333333-3333-4333-8333-333333333333";
const userId = "44444444-4444-4444-8444-444444444444";
const actor = { id: "55555555-5555-4555-8555-555555555555", email: "admin@example.test", displayName: "Admin", status: UserStatus.Active };
const issuer = "https://zitadel.test";
const provider = { enabled: true, issuer, zitadelProjectId: "1234", status: "Enabled" };
const app = { id: appId, tenantId, zitadelProjectId: "1234", tenant: { status: "Active", tenantOidcProvider: provider } };
const identity = { userId, providerType: "zitadel", identityProviderId: null, user: { status: UserStatus.Active } };
const membership = {
  id: membershipId, userId, status: "Active",
  roles: [{ roleId: "sso-login" }],
  groupMemberships: [],
  appGrants: [{ id: "grant-1" }],
};

function fixture() {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    tenantMembership: { findFirst: vi.fn().mockResolvedValue({
      ...membership, user: { status: UserStatus.Active },
      tenant: { name: "Acme", status: "Active" },
    }) },
    oAuthApplication: { findFirst: vi.fn().mockResolvedValue({ id: appId, name: "Home Assistant" }) },
    tenantAppClientGrant: {
      upsert: vi.fn().mockResolvedValue({ id: "grant-1", enabled: true }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    tenantNativeAppGrant: {
      upsert: vi.fn().mockResolvedValue({ id: "native-1", enabled: true }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    auditLogEntry: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    tenantMembership: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(membership),
      findFirst: vi.fn().mockResolvedValue({ id: membershipId }),
    },
    oAuthApplication: {
      findUnique: vi.fn().mockResolvedValue(app),
    },
    userIdentity: { findUnique: vi.fn().mockResolvedValue(identity) },
    $transaction: vi.fn(async (callback: (tx: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  return { svc: new AppConsumersService(prisma as never), tx, prisma };
}

describe("#430 unified membership / exact OAuth client authorization", () => {
  it("returns all members from one tenant list with no secrets", async () => {
    const f = fixture();
    f.prisma.tenantMembership.findMany.mockResolvedValue([{
      id: membershipId, status: "Active", createdAt: new Date(), user: { id: userId, email: "user@example.test", status: "Active" },
      appGrants: [{ oauthApplicationId: appId, application: { id: appId, name: "Home Assistant" }, enabled: true, updatedAt: new Date() }],
      nativeAppGrants: [{ clientKey: "web", enabled: true, updatedAt: new Date() }],
    }]);
    const items = await f.svc.list(tenantId);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ membershipId, nativeGrants: [{ clientKey: "web", enabled: true }],
      grants: [{ applicationId: appId, applicationName: "Home Assistant" }] });
    for (const forbidden of ["clientSecret", "refreshToken", "externalSubject", "zitadelGrantId"]) {
      expect(JSON.stringify(items)).not.toContain(forbidden);
    }
    expect(f.prisma.tenantMembership.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId } }));
  });

  it("grants a local app to an existing RP role-bearing member with audit and tenant lock", async () => {
    const f = fixture();
    await expect(f.svc.grant(tenantId, membershipId, appId, actor)).resolves.toMatchObject({
      applicationId: appId, enabled: true,
    });
    expect(f.tx.$queryRaw).toHaveBeenCalledOnce();
    expect(f.tx.tenantAppClientGrant.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { membershipId_oauthApplicationId: { membershipId, oauthApplicationId: appId } },
    }));
    expect(f.tx.auditLogEntry.create).toHaveBeenCalledOnce();
  });

  it("rejects cross-tenant app, self-service and inactive membership with no write", async () => {
    const f = fixture();
    f.tx.oAuthApplication.findFirst.mockResolvedValueOnce(null);
    await expect(f.svc.grant(tenantId, membershipId, appId, actor)).rejects.toBeInstanceOf(NotFoundException);
    await expect(f.svc.grant(tenantId, membershipId, appId, { ...actor, id: userId })).rejects.toBeInstanceOf(ForbiddenException);
    f.tx.tenantMembership.findFirst.mockResolvedValueOnce({
      ...membership, user: { status: UserStatus.Active }, tenant: { name: "Acme", status: "Active" }, status: "Suspended",
    });
    await expect(f.svc.grant(tenantId, membershipId, appId, actor)).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.tx.tenantAppClientGrant.upsert).not.toHaveBeenCalled();
  });

  it("keeps revoke history, does not remove membership or roles", async () => {
    const f = fixture();
    await expect(f.svc.revoke(tenantId, membershipId, appId, actor)).resolves.toEqual({
      applicationId: appId, enabled: false,
    });
    expect(f.tx.tenantAppClientGrant.updateMany).toHaveBeenCalledWith({
      where: { tenantId, membershipId, oauthApplicationId: appId, enabled: true },
      data: { enabled: false, updatedBy: actor.id },
    });
    f.tx.tenantAppClientGrant.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(f.svc.revoke(tenantId, membershipId, appId, actor)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("enforces sso-login AND matching grant: Viewer or Owner alone is insufficient", async () => {
    const f = fixture();
    expect(await f.svc.mayIssueClientToken(issuer, "123456", "external-client")).toBe(true);
    f.prisma.tenantMembership.findUnique.mockResolvedValueOnce({
      ...membership, roles: [{ roleId: "tenant-owner" }],
    });
    expect(await f.svc.mayIssueClientToken(issuer, "123456", "external-client")).toBe(false);
    f.prisma.tenantMembership.findUnique.mockResolvedValueOnce({
      ...membership, roles: [{ roleId: "sso-login" }], appGrants: [],
    });
    expect(await f.svc.mayIssueClientToken(issuer, "123456", "external-client")).toBe(false);
    f.prisma.tenantMembership.findUnique.mockResolvedValueOnce({
      ...membership, roles: [], groupMemberships: [{ group: { roles: [{ roleId: "sso-login" }] } }],
    });
    expect(await f.svc.mayIssueClientToken(issuer, "123456", "external-client")).toBe(true);
  });

  it("rejects wrong issuer, unlinked user, disabled tenant or grant and forged subject", async () => {
    const f = fixture();
    expect(await f.svc.mayIssueClientToken("http://bad", "123456", "client")).toBe(false);
    expect(await f.svc.mayIssueClientToken(issuer, "not-signed", "client")).toBe(false);
    f.prisma.userIdentity.findUnique.mockResolvedValueOnce(null);
    expect(await f.svc.mayIssueClientToken(issuer, "123456", "client")).toBe(false);
    f.prisma.oAuthApplication.findUnique.mockResolvedValueOnce({
      ...app, tenant: { status: "Active", tenantOidcProvider: { ...provider, enabled: false } },
    });
    expect(await f.svc.mayIssueClientToken(issuer, "123456", "client")).toBe(false);
    f.prisma.oAuthApplication.findUnique.mockResolvedValueOnce({
      ...app, tenant: { status: "Active", tenantOidcProvider: { ...provider, zitadelProjectId: "different" } },
    });
    expect(await f.svc.mayIssueClientToken(issuer, "123456", "client")).toBe(false);
    f.prisma.tenantMembership.findUnique.mockResolvedValueOnce({ ...membership, status: "Suspended" });
    expect(await f.svc.mayIssueClientToken(issuer, "123456", "client")).toBe(false);
  });

  it("keeps RP Web and CLI grants independent for the same UserIdentity", async () => {
    const f = fixture();
    expect(await f.svc.mayIssueNativeRpToken(issuer, "123456", "web")).toBe(true);
    expect(await f.svc.mayIssueNativeRpToken(issuer, "123456", "cli")).toBe(true);
    expect(f.prisma.tenantMembership.findFirst.mock.calls[0]?.[0] as unknown).toMatchObject({
      where: { nativeAppGrants: { some: { clientKey: "web", enabled: true } } },
    });
    expect(f.prisma.tenantMembership.findFirst.mock.calls[1]?.[0] as unknown).toMatchObject({
      where: { nativeAppGrants: { some: { clientKey: "cli", enabled: true } } },
    });
    f.prisma.tenantMembership.findFirst.mockResolvedValueOnce(null);
    expect(await f.svc.mayIssueNativeRpToken(issuer, "123456", "web")).toBe(false);
  });

  it("allows independent native grant/revoke and rejects unknown native keys", async () => {
    const f = fixture();
    expect(await f.svc.grantNative(tenantId, membershipId, "web", actor)).toEqual({
      clientKey: "web", enabled: true,
    });
    expect(await f.svc.revokeNative(tenantId, membershipId, "cli", actor)).toEqual({
      clientKey: "cli", enabled: false,
    });
    await expect(f.svc.grantNative(tenantId, membershipId, "unknown" as "web", actor))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  it("does not fall back to ZITADEL project roles for unknown, global or DCR clients", async () => {
    const f = fixture();
    f.prisma.oAuthApplication.findUnique.mockResolvedValueOnce(null);
    expect(await f.svc.mayIssueLegacyClientToken(issuer, "123456", "unknown-DCR")).toBe(false);
    f.prisma.oAuthApplication.findUnique.mockResolvedValueOnce({ id: "global", tenantId: null });
    expect(await f.svc.mayIssueLegacyClientToken(issuer, "123456", "platform-global")).toBe(false);
    expect(await f.svc.mayIssueLegacyClientToken(issuer, "123456", "tenant-client")).toBe(true);
  });

  it("does not authorize another user's app grant or another tenant with the same client label", async () => {
    const f = fixture();
    f.prisma.tenantMembership.findUnique.mockResolvedValueOnce(null);
    expect(await f.svc.mayIssueClientToken(issuer, "123456", "foreign-client")).toBe(false);
    f.prisma.oAuthApplication.findUnique.mockResolvedValueOnce({ ...app, tenantId: "foreign",
      tenant: { status: "Active", tenantOidcProvider: provider } });
    f.prisma.tenantMembership.findUnique.mockResolvedValueOnce(null);
    expect(await f.svc.mayIssueClientToken(issuer, "123456", "foreign-client")).toBe(false);
  });
});
