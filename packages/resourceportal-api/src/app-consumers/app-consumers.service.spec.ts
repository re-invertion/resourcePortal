import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { UserStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { AppConsumersService } from "./app-consumers.service";

const tenantId = "11111111-1111-4111-8111-111111111111";
const membershipId = "22222222-2222-4222-8222-222222222222";
const appId = "33333333-3333-4333-8333-333333333333";
const userId = "44444444-4444-4444-8444-444444444444";
const adminId = "55555555-5555-4555-8555-555555555555";
const actor = { id: adminId, email: "admin@tenant.test", displayName: "Admin", status: UserStatus.Active };
const mockConsumer = {
  membershipId, tenantId, tenant: { name: "Test tenant" },
  membership: {
    userId, status: "Active", user: { status: UserStatus.Active },
    roles: [], groupMemberships: [],
  },
};

function setup() {
  const tx = {
    tenantAppClientGrant: {
      upsert: vi.fn().mockResolvedValue({ id: "grant-1", enabled: true }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    auditLogEntry: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    tenantAppConsumer: {
      findFirst: vi.fn().mockResolvedValue(mockConsumer),
      findMany: vi.fn().mockResolvedValue([]),
    },
    oAuthApplication: {
      findFirst: vi.fn().mockResolvedValue({ id: appId, name: "Home Assistant" }),
      findUnique: vi.fn().mockResolvedValue({
        id: appId, tenantId, zitadelProjectId: "1234",
        tenant: { status: "Active", tenantOidcProvider: {
          enabled: true, issuer: "https://zitadel.test", zitadelProjectId: "1234",
        } },
      }),
    },
    userIdentity: { findUnique: vi.fn().mockResolvedValue({
      userId, providerType: "zitadel", identityProviderId: null,
      user: { id: userId, status: UserStatus.Active },
    }) },
    tenantMembership: {
      findUnique: vi.fn().mockResolvedValue({
        ...mockConsumer.membership, appConsumer: { grants: [{ oauthApplicationId: appId }] },
      }),
    },
    $transaction: vi.fn(async (callback: (tx: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  return { svc: new AppConsumersService(prisma as never), prisma, tx };
}

describe("app consumer client grants default-deny / tenant scoped (#398)", () => {
  it("does not return secrets, tokens or external subjects in app consumer list", async () => {
    const f = setup();
    f.prisma.tenantAppConsumer.findMany.mockResolvedValue([{
      ...mockConsumer, createdAt: new Date("2026-11-07T00:00:00Z"),
      membership: { ...mockConsumer.membership,
        user: { id: userId, email: "person@example.org", displayName: "Person", status: UserStatus.Active } },
      grants: [{ oauthApplicationId: appId, application: { name: "Home Assistant" },
        enabled: true, updatedAt: new Date("2026-11-07T00:00:00Z") }],
    }]);
    const result = await f.svc.list(tenantId);
    expect(JSON.stringify(result)).toContain("Home Assistant");
    for (const forbidden of ["clientSecret", "refreshToken", "externalSubject", "zitadelGrantId"]) {
      expect(JSON.stringify(result)).not.toContain(forbidden);
    }
    expect(f.prisma.tenantAppConsumer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId } }),
    );
  });

  it("grants only a tenant-local application to a role-free App Consumer with audit", async () => {
    const f = setup();
    expect(await f.svc.grant(tenantId, membershipId, appId, actor)).toMatchObject({
      applicationId: appId, enabled: true,
    });
    expect(f.prisma.oAuthApplication.findFirst).toHaveBeenCalledWith({
      where: { id: appId, tenantId },
      select: { id: true, name: true },
    });
    expect(f.tx.tenantAppClientGrant.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { membershipId_oauthApplicationId: { membershipId, oauthApplicationId: appId } } }),
    );
    expect(f.tx.auditLogEntry.create).toHaveBeenCalledOnce();
  });

  it("denies grants for foreign applications, self-service and inactive memberships", async () => {
    const f = setup();
    f.prisma.oAuthApplication.findFirst.mockResolvedValueOnce(null);
    await expect(f.svc.grant(tenantId, membershipId, appId, actor)).rejects.toBeInstanceOf(NotFoundException);
    await expect(f.svc.grant(tenantId, membershipId, appId, {
      ...actor, id: userId,
    })).rejects.toBeInstanceOf(ForbiddenException);
    f.prisma.tenantAppConsumer.findFirst.mockResolvedValueOnce({
      ...mockConsumer, membership: { ...mockConsumer.membership, status: "Suspended" },
    });
    await expect(f.svc.grant(tenantId, membershipId, appId, actor)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("revokes without deleting grant history and requires an active grant", async () => {
    const f = setup();
    expect(await f.svc.revoke(tenantId, membershipId, appId, actor)).toEqual({
      applicationId: appId, enabled: false,
    });
    expect(f.tx.tenantAppClientGrant.updateMany).toHaveBeenCalledWith({
      where: { tenantId, membershipId, oauthApplicationId: appId, enabled: true },
      data: { enabled: false, updatedBy: adminId },
    });
    expect(f.tx.auditLogEntry.create).toHaveBeenCalledOnce();
    f.tx.tenantAppClientGrant.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(f.svc.revoke(tenantId, membershipId, appId, actor)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("requires exact issuer, immutable subject, tenant-local app and live consumer grant", async () => {
    const f = setup();
    expect(await f.svc.mayIssueClientToken("https://zitadel.test", "123456", "client-1")).toBe(true);
    expect(await f.svc.mayIssueClientToken("http://not-https", "123456", "client-1")).toBe(false);
    f.prisma.userIdentity.findUnique.mockResolvedValueOnce(null);
    expect(await f.svc.mayIssueClientToken("https://zitadel.test", "not-linked", "client-1")).toBe(false);
    f.prisma.tenantMembership.findUnique.mockResolvedValueOnce({
      ...mockConsumer.membership, appConsumer: { grants: [] },
    });
    expect(await f.svc.mayIssueClientToken("https://zitadel.test", "123456", "client-1")).toBe(false);
    f.prisma.oAuthApplication.findUnique.mockResolvedValueOnce({
      id: appId, tenantId: "foreign", zitadelProjectId: "1234",
      tenant: { status: "Active", tenantOidcProvider: {
        enabled: true, issuer: "https://zitadel.test", zitadelProjectId: "9999",
      } },
    });
    expect(await f.svc.mayIssueClientToken("https://zitadel.test", "123456", "client-1")).toBe(false);
  });

  it("rejects wrong app and tenant across a 2 subjects × 2 clients × 2 tenants authorization matrix", async () => {
    const f = setup();
    const tenants = ["tenant-A", "tenant-B"];
    const subjects = ["10101", "20202"];
    const clients = ["home-assistant", "mypa"];
    const mapped = {
      "tenant-A": { "10101": ["home-assistant"], "20202": ["mypa"] },
      "tenant-B": { "10101": [], "20202": ["home-assistant"] },
    } as Record<string, Record<string, string[]>>;
    let actualTenant = tenants[0];
    f.prisma.oAuthApplication.findUnique.mockImplementation(({ where }: { where: { clientId: string } }) => ({
      id: `${actualTenant}:${where.clientId}`,
      tenantId: actualTenant,
      zitadelProjectId: `project-${actualTenant}`,
      tenant: { status: "Active", tenantOidcProvider: {
        enabled: true, issuer: "https://zitadel.test",
        zitadelProjectId: `project-${actualTenant}`,
      } },
    }));
    f.prisma.userIdentity.findUnique.mockImplementation(({ where }: {
      where: { issuer_externalSubject: { externalSubject: string } };
    }) => ({
      userId: where.issuer_externalSubject.externalSubject,
      providerType: "zitadel", identityProviderId: null,
      user: { status: UserStatus.Active },
    }));
    f.prisma.tenantMembership.findUnique.mockImplementation(({ where }: {
      where: { userId_tenantId: { userId: string; tenantId: string } };
    }) => {
      const { userId, tenantId: targetTenant } = where.userId_tenantId;
      if (targetTenant !== actualTenant) return null;
      return {
        status: "Active", roles: [], groupMemberships: [],
        appConsumer: { grants: mapped[targetTenant][userId].map(name => ({
          oauthApplicationId: `${targetTenant}:${name}`,
        })) },
      };
    });

    for (const tenant of tenants) {
      actualTenant = tenant;
      for (const subject of subjects) {
        for (const client of clients) {
          const expected = mapped[tenant][subject].includes(client);
          expect(
            await f.svc.mayIssueClientToken("https://zitadel.test", subject, client),
            `${tenant}, user ${subject}, client ${client}`,
          ).toBe(expected);
        }
      }
    }
    expect(f.prisma.userIdentity.findUnique).toHaveBeenCalledTimes(8);
  });

  it("never treats regular Viewer as an implicit OAuth client grant", async () => {
    const f = setup();
    f.prisma.tenantMembership.findUnique.mockResolvedValue({
      ...mockConsumer.membership,
      appConsumer: null, roles: [{ roleId: "tenant-viewer" }], groupMemberships: [],
    });
    expect(await f.svc.mayIssueClientToken("https://zitadel.test", "123456", "client-1")).toBe(false);
    f.prisma.tenantMembership.findUnique.mockResolvedValue({
      ...mockConsumer.membership,
      appConsumer: null, roles: [{ roleId: "tenant-owner" }], groupMemberships: [],
    });
    expect(await f.svc.mayIssueClientToken("https://zitadel.test", "123456", "client-1")).toBe(true);
  });
});
