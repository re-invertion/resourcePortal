import { MembershipStatus, TenantStatus, UserStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { ConfigService } from "@nestjs/config";
import type { PrismaService } from "../prisma/prisma.service";
import { TenantOidcService } from "./tenant-oidc.service";
import type { ZitadelTenantProjectService } from "./zitadel-tenant-project.service";

const tenantId = "tenant-a";
const nativeIssuer = "https://auth.example.com";

function fixture(configValues: Record<string, string> = {}) {
  const project = {
    issuer: nativeIssuer,
    createProject: vi.fn().mockResolvedValue("123"),
    findExistingProjectForTenant: vi.fn().mockResolvedValue(null),
    readProject: vi.fn().mockResolvedValue({
      id: "123", projectRoleCheck: true, hasProjectCheck: true,
    }),
    ensureMemberRole: vi.fn().mockResolvedValue(undefined),
    verifyIssuerSecurity: vi.fn().mockResolvedValue(undefined),
    verifyAppConsumerActionsV2Gate: vi.fn().mockResolvedValue(undefined),
    verifyMemberGrant: vi.fn().mockResolvedValue(undefined),
    assignMember: vi.fn().mockResolvedValue("grant-new"),
    findExistingMemberGrant: vi.fn().mockResolvedValue(null),
    revokeMember: vi.fn().mockResolvedValue(undefined),
  };
  const provider = {
    tenantId,
    zitadelProjectId: "123",
    enabled: false,
    status: "PendingGrants",
    issuer: nativeIssuer,
    grantsReconciledAt: null,
    lastErrorCode: null,
    tenant: { name: "Tenant A" },
    _count: { grants: 0 },
  };
  const prisma = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(),
    tenant: { findUnique: vi.fn().mockResolvedValue({ status: TenantStatus.Active }) },
    tenantOidcProvider: {
      upsert: vi.fn().mockResolvedValue({ ...provider, zitadelProjectId: null }),
      findUnique: vi.fn().mockResolvedValue(provider),
      update: vi.fn().mockResolvedValue(provider),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    tenantMembership: { findMany: vi.fn().mockResolvedValue([]) },
    tenantAppConsumer: { findMany: vi.fn().mockResolvedValue([]) },
    oAuthApplication: { count: vi.fn().mockResolvedValue(0) },
    auditLogEntry: { create: vi.fn().mockResolvedValue({ id: "security-audit" }) },
    tenantOidcGrant: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: "pending-row" }),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
  };
  prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma));
  const service = new TenantOidcService(
    prisma as unknown as PrismaService,
    project as unknown as ZitadelTenantProjectService,
    { get: (key: string) => configValues[key] } as ConfigService,
  );
  return { service, prisma, project, provider };
}

describe("Tenant OIDC management fails closed", () => {
  it("provisions a project but never auto-enables the issuer", async () => {
    const f = fixture();
    const result = await f.service.provision(tenantId);
    expect(result.enabled).toBe(false);
    expect(f.prisma.tenantOidcProvider.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId },
        data: expect.objectContaining({ status: "PendingGrants", enabled: false }) as unknown as Record<string, unknown>,
      }),
    );
    expect(f.project.createProject).toHaveBeenCalledWith(tenantId);
  });

  it("does not provision suspended tenants", async () => {
    const f = fixture();
    f.prisma.tenant.findUnique.mockResolvedValue({ status: TenantStatus.Suspended });
    await expect(f.service.provision(tenantId)).rejects.toThrow("not active");
    expect(f.project.createProject).not.toHaveBeenCalled();
  });

  it("locks tenant before upstream grant issuance and holds the lock through persistence", async () => {
    const f = fixture();
    f.prisma.tenantMembership.findMany.mockResolvedValue([{ userId: "u1", status: MembershipStatus.Active,
      user: { identities: [{ issuer: nativeIssuer, providerType: "zitadel", externalSubject: "native-u1", identityProviderId: null }] },
    }]);
    await f.service.reconcileGrants(tenantId);
    expect(f.prisma.$queryRaw).toHaveBeenCalledOnce();
    expect(f.prisma.$queryRaw.mock.invocationCallOrder[0])
      .toBeLessThan(f.project.assignMember.mock.invocationCallOrder[0]);
    expect(f.prisma.tenantOidcProvider.updateMany.mock.invocationCallOrder[0])
      .toBeLessThan(f.project.assignMember.mock.invocationCallOrder[0]);
    expect(f.prisma.$transaction).toHaveBeenCalledOnce();
  });

  it("excludes App Consumers from project-wide grants until a certified client gate is active", async () => {
    const f = fixture();
    await f.service.reconcileGrants(tenantId);
    expect(f.prisma.tenantMembership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId, appConsumer: { is: null },
          OR: [
            { roles: { some: { roleId: { not: "sso-login" } } } },
            { groupMemberships: { some: { group: { roles: { some: {
              roleId: { not: "sso-login" },
            } } } } } },
          ],
        }) as Record<string, unknown>,
      }),
    );
    expect(f.project.assignMember).not.toHaveBeenCalled();
  });

  it("verifies the LIVE signed target before including App Users in tenant-wide upstream grants", async () => {
    const f = fixture({
      RP_APP_CONSUMER_ACTIONS_V2_ENABLED: "true",
      RP_APP_CONSUMER_ACTIONS_V2_CERTIFIED: "true",
    });
    f.prisma.tenantMembership.findMany.mockResolvedValue([{
      userId: "app-consumer-1", status: MembershipStatus.Active,
      user: { identities: [{
        issuer: nativeIssuer, providerType: "zitadel",
        externalSubject: "zitadel-app-user", identityProviderId: null,
      }] },
    }]);
    await f.service.reconcileGrants(tenantId);
    expect(f.project.verifyAppConsumerActionsV2Gate).toHaveBeenCalledOnce();
    expect(f.project.verifyAppConsumerActionsV2Gate.mock.invocationCallOrder[0])
      .toBeLessThan(f.project.assignMember.mock.invocationCallOrder[0]);
    const [membershipQuery] = f.prisma.tenantMembership.findMany.mock.calls[0] as [
      { where: Record<string, unknown> },
    ];
    expect(membershipQuery.where).not.toHaveProperty("appConsumer");
    expect(f.project.assignMember).toHaveBeenCalledWith("zitadel-app-user", "123");
  });

  it("never grants an App Consumer tenant-wide role when the live Action binding is missing", async () => {
    const f = fixture({
      RP_APP_CONSUMER_ACTIONS_V2_ENABLED: "true",
      RP_APP_CONSUMER_ACTIONS_V2_CERTIFIED: "true",
    });
    f.project.verifyAppConsumerActionsV2Gate.mockRejectedValue(
      new Error("App Consumer Actions V2 execution binding not verified"),
    );
    await expect(f.service.reconcileGrants(tenantId)).rejects.toThrow("execution binding not verified");
    expect(f.prisma.tenantMembership.findMany).not.toHaveBeenCalled();
    expect(f.project.assignMember).not.toHaveBeenCalled();
    const updates = f.prisma.tenantOidcProvider.updateMany.mock.calls as Array<[
      { data: { enabled: boolean; status: string } },
    ]>;
    expect(updates.some(([row]) =>
      row.data.status === "ReconciliationFailed" && row.data.enabled === false)).toBe(true);
  });

  it("leaves ordinary tenant grants alone when there are no App Consumers", async () => {
    const f = fixture({ RP_APP_CONSUMER_ACTIONS_V2_ENABLED: "true",
      RP_APP_CONSUMER_ACTIONS_V2_CERTIFIED: "true" });
    expect(await f.service.enforceAppConsumerActionsV2Safety()).toEqual({
      state: "no-consumers", revoked: 0,
    });
    expect(f.project.verifyAppConsumerActionsV2Gate).not.toHaveBeenCalled();
    expect(f.prisma.tenantOidcProvider.updateMany).not.toHaveBeenCalled();
  });

  it("preserves valid App Consumer project roles when the live signed execution is verified", async () => {
    const f = fixture({ RP_APP_CONSUMER_ACTIONS_V2_ENABLED: "true",
      RP_APP_CONSUMER_ACTIONS_V2_CERTIFIED: "true" });
    f.prisma.tenantAppConsumer.findMany.mockResolvedValue([
      { tenantId, membership: { userId: "consumer" } },
    ]);
    f.prisma.tenantOidcGrant.findMany.mockResolvedValue([
      { id: "grant-1", tenantId, userId: "consumer", zitadelUserId: "zitadel-consumer", zitadelGrantId: "zgrant-1" },
    ]);
    expect(await f.service.enforceAppConsumerActionsV2Safety()).toEqual({
      state: "verified", revoked: 0,
    });
    expect(f.project.verifyAppConsumerActionsV2Gate).toHaveBeenCalledOnce();
    expect(f.project.revokeMember).not.toHaveBeenCalled();
    expect(f.prisma.tenantOidcProvider.updateMany).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "revokes only App Consumer grants on missing or disabled execution (flag enabled=%s)",
    async (enabled) => {
      const f = fixture(enabled ? { RP_APP_CONSUMER_ACTIONS_V2_ENABLED: "true",
        RP_APP_CONSUMER_ACTIONS_V2_CERTIFIED: "true" } : {});
      f.prisma.tenantAppConsumer.findMany.mockResolvedValue([
        { tenantId, membership: { userId: "consumer" } },
      ]);
      const records = [
        { id: "grant-1", tenantId, userId: "consumer", zitadelUserId: "zitadel-consumer", zitadelGrantId: "zgrant-1" },
        { id: "operator-grant", tenantId, userId: "operator", zitadelUserId: "zitadel-operator", zitadelGrantId: "zgrant-operator" },
      ];
      f.prisma.tenantOidcGrant.findMany.mockImplementation(
        (query: { where: { userId?: { in: string[] }; tenantId?: string } }) =>
          Promise.resolve(records.filter((row) =>
            (!query.where.tenantId || row.tenantId === query.where.tenantId) &&
            (!query.where.userId || query.where.userId.in.includes(row.userId)))),
      );
      f.project.verifyAppConsumerActionsV2Gate.mockRejectedValue(new Error("remote configuration changed"));
      expect(await f.service.enforceAppConsumerActionsV2Safety()).toEqual({
        state: "app-consumer-grants-revoked", revoked: 1,
      });
      expect(f.project.revokeMember).toHaveBeenCalledExactlyOnceWith("zitadel-consumer", "zgrant-1");
      expect(f.prisma.tenantOidcGrant.delete).toHaveBeenCalledWith({ where: { id: "grant-1" } });
      expect(f.prisma.tenantOidcGrant.delete).not.toHaveBeenCalledWith({ where: { id: "operator-grant" } });
      expect(f.prisma.tenantOidcProvider.updateMany).toHaveBeenCalledWith({
        where: { tenantId, status: { notIn: ["Disabling", "Disabled", "Deleted"] } },
        data: { enabled: false, status: "NeedsReconciliation", grantsReconciledAt: null,
          lastErrorCode: "APP_CONSUMER_ACTION_BINDING_LOST" },
      });
      expect(f.prisma.$queryRaw).toHaveBeenCalledOnce();
      expect(f.prisma.auditLogEntry.create).toHaveBeenCalledOnce();
      const audit = f.prisma.auditLogEntry.create.mock.calls[0][0] as {
        data: { action: string; changes: { revokedCount: number } };
      };
      expect(audit.data.action).toBe("tenant_oidc.app_consumer_binding_revoked");
      expect(audit.data.changes.revokedCount).toBe(1);
      expect(f.prisma.$queryRaw.mock.invocationCallOrder[0])
        .toBeLessThan(f.project.revokeMember.mock.invocationCallOrder[0]);
      if (enabled) expect(f.project.verifyAppConsumerActionsV2Gate).toHaveBeenCalledOnce();
      else expect(f.project.verifyAppConsumerActionsV2Gate).not.toHaveBeenCalled();
    },
  );

  it("retains historical RP owner grants before Actions V2 first cutover despite sso-login backfill", async () => {
    const f = fixture();
    // Prisma filters historical role-bearing members out of ssoMembers in
    // uncertified mode. A legacy owner retains its normal RP project role.
    f.prisma.tenantMembership.findMany.mockResolvedValue([]);
    f.prisma.tenantOidcGrant.findMany.mockResolvedValue([{
      tenantId, userId: "legacy-owner", zitadelGrantId: "old-role-grant",
    }]);
    expect(await f.service.enforceAppConsumerActionsV2Safety()).toEqual({
      state: "no-consumers", revoked: 0,
    });
    const [where] = f.prisma.tenantMembership.findMany.mock.calls[0] as [
      { where: { AND?: unknown } },
    ];
    expect(where.where.AND).toEqual([
      { roles: { none: { roleId: { not: "sso-login" } } } },
      { groupMemberships: { none: { group: { roles: { some: {
        roleId: { not: "sso-login" },
      } } } } } },
    ]);
    expect(f.project.revokeMember).not.toHaveBeenCalled();
    expect(f.prisma.tenantOidcProvider.updateMany).not.toHaveBeenCalled();
  });

  it("protects SSO-only members before certification while preserving legacy role owners", async () => {
    const f = fixture();
    f.prisma.tenantMembership.findMany.mockResolvedValue([
      { tenantId, userId: "sso-only" },
    ]);
    f.prisma.tenantOidcGrant.findMany.mockResolvedValue([{
      id: "grant-sso-only", tenantId, userId: "sso-only",
      zitadelUserId: "native-sso-only", zitadelGrantId: "upstream-sso-only",
    }]);
    await expect(f.service.enforceAppConsumerActionsV2Safety()).resolves.toEqual({
      state: "app-consumer-grants-revoked", revoked: 1,
    });
    expect(f.project.revokeMember).toHaveBeenCalledWith("native-sso-only", "upstream-sso-only");
  });

  it("protects #430 SSO members without a legacy App Consumer marker on binding loss", async () => {
    const f = fixture({ RP_APP_CONSUMER_ACTIONS_V2_ENABLED: "true",
      RP_APP_CONSUMER_ACTIONS_V2_CERTIFIED: "true" });
    f.prisma.tenantMembership.findMany.mockResolvedValue([
      { tenantId, userId: "unified-member" },
    ]);
    f.prisma.tenantOidcGrant.findMany.mockResolvedValue([
      { id: "unified-grant", tenantId, userId: "unified-member",
        zitadelUserId: "native-unified", zitadelGrantId: "remote-unified" },
    ]);
    f.project.verifyAppConsumerActionsV2Gate.mockRejectedValue(new Error("binding not found"));
    expect(await f.service.enforceAppConsumerActionsV2Safety()).toEqual({
      state: "app-consumer-grants-revoked", revoked: 1,
    });
    expect(f.prisma.tenantAppConsumer.findMany).toHaveBeenCalledOnce();
    expect(f.prisma.tenantMembership.findMany).toHaveBeenCalledWith({
      where: { status: MembershipStatus.Active, OR: [
        { roles: { some: { roleId: "sso-login" } } },
        { groupMemberships: { some: { group: { roles: { some: {
          roleId: "sso-login",
        } } } } } },
      ] },
      select: { tenantId: true, userId: true },
    });
    expect(f.project.revokeMember).toHaveBeenCalledWith("native-unified", "remote-unified");
    expect(f.prisma.tenantOidcGrant.delete).toHaveBeenCalledWith({
      where: { id: "unified-grant" },
    });
    expect(f.prisma.tenantOidcProvider.updateMany).toHaveBeenCalledWith({
      where: { tenantId, status: { notIn: ["Disabling", "Disabled", "Deleted"] } },
      data: { enabled: false, status: "NeedsReconciliation", grantsReconciledAt: null,
        lastErrorCode: "APP_CONSUMER_ACTION_BINDING_LOST" },
    });
  });

  it("does not revoke unified member grants while the exact-client Action is verified", async () => {
    const f = fixture({ RP_APP_CONSUMER_ACTIONS_V2_ENABLED: "true",
      RP_APP_CONSUMER_ACTIONS_V2_CERTIFIED: "true" });
    f.prisma.tenantMembership.findMany.mockResolvedValue([{ tenantId, userId: "unified-member" }]);
    f.prisma.tenantOidcGrant.findMany.mockResolvedValue([
      { id: "unified-grant", tenantId, userId: "unified-member",
        zitadelUserId: "native-unified", zitadelGrantId: "remote-unified" },
    ]);
    expect(await f.service.enforceAppConsumerActionsV2Safety()).toEqual({
      state: "verified", revoked: 0,
    });
    expect(f.project.verifyAppConsumerActionsV2Gate).toHaveBeenCalledOnce();
    expect(f.project.revokeMember).not.toHaveBeenCalled();
  });

  it("retains the revocation intent and blocks tenant provider on upstream failure", async () => {
    const f = fixture({ RP_APP_CONSUMER_ACTIONS_V2_ENABLED: "true",
      RP_APP_CONSUMER_ACTIONS_V2_CERTIFIED: "true" });
    f.prisma.tenantAppConsumer.findMany.mockResolvedValue([
      { tenantId, membership: { userId: "consumer" } },
    ]);
    f.prisma.tenantOidcGrant.findMany.mockResolvedValue([
      { id: "grant-1", tenantId, userId: "consumer", zitadelUserId: "zitadel-consumer", zitadelGrantId: "zgrant-1" },
    ]);
    f.project.verifyAppConsumerActionsV2Gate.mockRejectedValue(new Error("remote target not installed"));
    f.project.revokeMember.mockRejectedValue(new Error("upstream response including sensitive material"));
    await expect(f.service.enforceAppConsumerActionsV2Safety())
      .rejects.toThrow("App Consumer upstream revocation pending secure recovery");
    expect(f.prisma.tenantOidcGrant.delete).not.toHaveBeenCalled();
    expect(f.prisma.auditLogEntry.create).not.toHaveBeenCalled();
    expect(f.prisma.tenantOidcProvider.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({
        enabled: false, lastErrorCode: "APP_CONSUMER_ACTION_BINDING_LOST",
      }) as Record<string, unknown> }),
    );
  });

  it("revokes grants when membership is no longer active", async () => {
    const f = fixture();
    f.prisma.tenantOidcGrant.findMany.mockResolvedValue([{
      id: "grant-row", userId: "user-removed",
      zitadelUserId: "zitadel-removed", zitadelGrantId: "zgrant-removed",
    }]);
    await f.service.reconcileGrants(tenantId);
    expect(f.prisma.tenantOidcGrant.findMany).toHaveBeenCalledWith({ where: { tenantId } });
    expect(f.project.revokeMember).toHaveBeenCalledWith("zitadel-removed", "zgrant-removed");
    expect(f.prisma.tenantOidcGrant.delete).toHaveBeenCalledWith({ where: { id: "grant-row" } });
    expect(f.prisma.tenantOidcProvider.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId, enabled: false, status: "Reconciling", grantsReconciledAt: null },
        data: expect.objectContaining({ status: "GrantsReconciled", enabled: false }) as Record<string, unknown>,
      }),
    );
  });

  it("denies synchronization when an active member lacks verified native identity", async () => {
    const f = fixture();
    f.prisma.tenantMembership.findMany.mockResolvedValue([{
      userId: "u1",
      user: { status: UserStatus.Active, identities: [] },
      status: MembershipStatus.Active,
    }]);
    await expect(f.service.reconcileGrants(tenantId)).rejects.toThrow("lacks verified native");
    expect(f.prisma.tenantOidcProvider.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId, status: "Reconciling" },
        data: expect.objectContaining({ status: "ReconciliationFailed", enabled: false }) as Record<string, unknown> }),
    );
    expect(f.project.assignMember).not.toHaveBeenCalled();
  });

  it("revokes a user's ZITADEL authorization before RP suspends membership", async () => {
    const f = fixture();
    f.prisma.tenantOidcGrant.findUnique = vi.fn().mockResolvedValue({
      id: "row-1", userId: "u1", zitadelUserId: "native-u1", zitadelGrantId: "remote-1",
    });
    f.prisma.tenantOidcProvider.updateMany = vi.fn().mockResolvedValue({ count: 1 });
    await f.service.revokeGrantBeforeMembershipRemoval(tenantId, "u1");
    expect(f.project.revokeMember).toHaveBeenCalledWith("native-u1", "remote-1");
    expect(f.prisma.tenantOidcProvider.updateMany).toHaveBeenCalledWith({
      where: { tenantId, status: { notIn: ["Disabling", "Disabled", "Deleted"] } },
      data: {
        enabled: false, status: "NeedsReconciliation", grantsReconciledAt: null,
      },
    });
  });

  it("refuses to revoke an untracked grant if the tenant IdP were enabled", async () => {
    const f = fixture();
    f.prisma.tenantOidcProvider.findUnique.mockResolvedValue({
      ...f.provider, enabled: true,
    });
    f.prisma.tenantOidcGrant.findUnique = vi.fn().mockResolvedValue(null);
    await expect(
      f.service.revokeGrantBeforeMembershipRemoval(tenantId, "u1"),
    ).rejects.toThrow("untracked grant");
  });

  it("disables tenant IdP only after removing all tracked upstream role assignments", async () => {
    const f = fixture();
    f.prisma.tenantOidcGrant.findMany.mockResolvedValue([{
      id: "row-1", zitadelUserId: "zitadel-1", zitadelGrantId: "grant-1",
    }]);
    const result = await f.service.disable(tenantId);
    expect(result.enabled).toBe(false);
    expect(f.project.revokeMember).toHaveBeenCalledWith("zitadel-1", "grant-1");
    expect(f.prisma.tenantOidcGrant.delete).toHaveBeenCalledTimes(1);
    expect(f.prisma.$queryRaw.mock.invocationCallOrder[0])
      .toBeLessThan(f.project.revokeMember.mock.invocationCallOrder[0]);
    expect(f.prisma.tenantOidcProvider.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "Disabled", enabled: false }) as unknown as Record<string, unknown> }),
    );
  });

  it("does not delete ZITADEL project while OAuth clients exist", async () => {
    const f = fixture();
    f.prisma.oAuthApplication.count.mockResolvedValue(1);
    f.project.deleteProject = vi.fn();
    await expect(f.service.delete(tenantId)).rejects.toThrow("Remove tenant OIDC clients first");
    expect(f.project.deleteProject).not.toHaveBeenCalled();
  });

  it("does not treat shared-project legacy OAuth clients as dependencies of an unprovisioned tenant project", async () => {
    const f = fixture();
    f.prisma.tenantOidcProvider.findUnique.mockResolvedValue({
      ...f.provider,
      zitadelProjectId: null,
    });
    f.prisma.tenantOidcProvider.delete = vi.fn().mockResolvedValue({});
    f.project.deleteProject = vi.fn();
    await expect(f.service.delete(tenantId)).resolves.toEqual({ deleted: true });
    expect(f.prisma.oAuthApplication.count).not.toHaveBeenCalled();
    expect(f.project.deleteProject).not.toHaveBeenCalled();
  });

  it("scopes dependent OAuth client checks to the actual tenant project", async () => {
    const f = fixture();
    f.prisma.oAuthApplication.count.mockResolvedValue(1);
    await expect(f.service.delete(tenantId)).rejects.toThrow("Remove tenant OIDC clients first");
    expect(f.prisma.oAuthApplication.count).toHaveBeenCalledWith({
      where: { tenantId, zitadelProjectId: "123" },
    });
  });

  it("does not issue a tenant grant from a linked upstream federated identity", async () => {
    const f = fixture();
    f.prisma.tenantMembership.findMany.mockResolvedValue([{
      userId: "u1",
      user: { identities: [{
        issuer: nativeIssuer, externalSubject: "zitadel-u1", identityProviderId: "external-idp",
      }] },
    }]);
    await expect(f.service.reconcileGrants(tenantId)).rejects.toThrow("lacks verified native");
    expect(f.project.assignMember).not.toHaveBeenCalled();
  });

  it("rejects non-native providerType even if issuer and missing IdP link appear valid", async () => {
    const f = fixture();
    f.prisma.tenantMembership.findMany.mockResolvedValue([{
      userId: "forged",
      user: { identities: [{
        providerType: "external-oidc",
        issuer: nativeIssuer,
        externalSubject: "zitadel-u1",
        identityProviderId: null,
      }] },
    }]);
    await expect(f.service.reconcileGrants(tenantId)).rejects.toThrow("lacks verified native");
    expect(f.project.assignMember).not.toHaveBeenCalled();
  });

  it("never queries grants or members without tenant scope", async () => {
    const f = fixture();
    const tenantB = "tenant-b";
    f.prisma.tenantOidcProvider.findUnique.mockResolvedValue({
      ...f.provider, tenantId: tenantB, zitadelProjectId: "987",
    });
    f.prisma.tenantMembership.findMany.mockResolvedValue([{
      userId: "user-b", status: MembershipStatus.Active,
      user: { identities: [{ providerType: "zitadel", issuer: nativeIssuer, externalSubject: "zitadel-user-b", identityProviderId: null }] },
    }]);
    await f.service.reconcileGrants(tenantB);
    expect(f.prisma.tenantOidcGrant.findMany).toHaveBeenCalledWith({ where: { tenantId: tenantB } });
    expect(f.prisma.tenantMembership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: tenantB }) as Record<string, unknown> }),
    );
    expect(f.project.assignMember).toHaveBeenCalledWith("zitadel-user-b", "987");
    expect(f.prisma.tenantOidcGrant.create).toHaveBeenCalledWith({
      data: { tenantId: tenantB, userId: "user-b", zitadelUserId: "zitadel-user-b", status: "Pending" },
    });
    expect(f.prisma.tenantOidcGrant.update).toHaveBeenCalledWith({
      where: { id: "pending-row" }, data: { zitadelGrantId: "grant-new", status: "Active" },
    });
    expect(f.prisma.tenantOidcGrant.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ tenantId }) as Record<string, unknown> }),
    );
  });

  it("fails closed when remote grant revocation fails", async () => {
    const f = fixture();
    f.prisma.tenantOidcGrant.findMany.mockResolvedValue([{
      id: "grant-old", userId: "removed", zitadelUserId: "removed-remote",
      zitadelGrantId: "remote-grant-old",
    }]);
    f.project.revokeMember.mockRejectedValue(new Error("upstream timeout"));
    await expect(f.service.reconcileGrants(tenantId)).rejects.toThrow("upstream timeout");
    expect(f.prisma.tenantOidcGrant.delete).not.toHaveBeenCalled();
    expect(f.prisma.tenantOidcProvider.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ enabled: false, status: "ReconciliationFailed" }) as Record<string, unknown> }),
    );
  });

  it("refuses late reconciliation when membership invalidated the snapshot while remote grants were syncing", async () => {
    const f = fixture();
    // The concurrent membership transaction commits NeedsReconciliation;
    // the conditional finalization cannot overwrite that state.
    f.prisma.tenantOidcProvider.updateMany.mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    await expect(f.service.reconcileGrants(tenantId))
      .rejects.toThrow("membership changed during grant reconciliation");
    expect(f.prisma.tenantOidcProvider.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId, enabled: false, status: "Reconciling", grantsReconciledAt: null },
        data: expect.objectContaining({ status: "GrantsReconciled" }) as Record<string, unknown>,
      }),
    );
    expect(f.prisma.tenantOidcProvider.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId, status: "Reconciling" } }),
    );
    expect(f.prisma.tenantOidcProvider.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "GrantsReconciled" }) as unknown as Record<string, unknown> }),
    );
  });

  it("does not reactivate a tenant after membership changed between reconciliation and activation", async () => {
    const f = fixture();
    const snapshot = new Date("2026-10-17T12:00:00.000Z");
    const reconciled = { ...f.provider, status: "GrantsReconciled", grantsReconciledAt: snapshot };
    f.prisma.tenantOidcProvider.findUnique.mockResolvedValue(reconciled);
    // Simulates a committed membership change that cleared snapshot timestamp
    // during the final remote readProject await.
    f.prisma.tenantOidcProvider.updateMany.mockResolvedValue({ count: 0 });
    const enabledService = new TenantOidcService(
      f.prisma as unknown as PrismaService,
      f.project as unknown as ZitadelTenantProjectService,
      { get: vi.fn().mockReturnValue("true") } as never,
    );
    vi.spyOn(enabledService, "reconcileGrants").mockResolvedValue(undefined as never);
    await expect(enabledService.activate(tenantId)).rejects.toThrow("membership changed before OIDC activation");
    expect(f.prisma.tenantOidcProvider.updateMany).toHaveBeenCalledWith({
      where: {
        tenantId, zitadelProjectId: reconciled.zitadelProjectId,
        enabled: false, status: "GrantsReconciled", grantsReconciledAt: snapshot,
      },
      data: { enabled: true, status: "Active", lastErrorCode: null },
    });
    expect(f.prisma.tenantOidcProvider.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ enabled: true }) as unknown as Record<string, unknown> }),
    );
  });

  it("does not activate without a certified rollout gate", async () => {
    const f = fixture();
    await expect(f.service.activate(tenantId)).rejects.toThrow("disabled until rollout verification");
    expect(f.project.assignMember).not.toHaveBeenCalled();
  });

  it("only issues grants for verified native identities belonging to this tenant", async () => {
    const f = fixture();
    f.prisma.tenantMembership.findMany.mockResolvedValue([{
      userId: "u1",
      user: { status: UserStatus.Active, identities: [{
        providerType: "zitadel", issuer: nativeIssuer, externalSubject: "zitadel-u1", identityProviderId: null,
      }] },
      status: MembershipStatus.Active,
    }]);
    await f.service.reconcileGrants(tenantId);
    expect(f.prisma.tenantMembership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({
        tenantId, status: MembershipStatus.Active,
      }) as unknown as Record<string, unknown> }),
    );
    expect(f.project.assignMember).toHaveBeenCalledWith("zitadel-u1", "123");
    expect(f.prisma.tenantOidcGrant.create).toHaveBeenCalledWith({
      data: {
        tenantId, userId: "u1", zitadelUserId: "zitadel-u1",
        status: "Pending",
      },
    });
  });
  it("persists a Pending intent before assigning external permissions and compensates failed DB persistence", async () => {
    const f = fixture();
    f.prisma.tenantMembership.findMany.mockResolvedValue([{ userId: "u1", status: MembershipStatus.Active,
      user: { identities: [{ issuer: nativeIssuer, providerType: "zitadel", externalSubject: "native-u1", identityProviderId: null }] },
    }]);
    f.prisma.tenantOidcGrant.update.mockRejectedValue(new Error("postgres write unavailable"));
    await expect(f.service.reconcileGrants(tenantId)).rejects.toThrow("postgres write unavailable");
    expect(f.prisma.tenantOidcGrant.create).toHaveBeenCalledWith({
      data: { tenantId, userId: "u1", zitadelUserId: "native-u1", status: "Pending" },
    });
    expect(f.project.findExistingMemberGrant).toHaveBeenCalledWith("native-u1", "123");
    expect(f.prisma.tenantOidcGrant.create.mock.invocationCallOrder[0]).toBeLessThan(
      f.project.assignMember.mock.invocationCallOrder[0],
    );
    expect(f.project.revokeMember).toHaveBeenCalledWith("native-u1", "grant-new");
    const updates = f.prisma.tenantOidcProvider.updateMany.mock.calls as unknown as Array<[
      { data: { enabled: boolean; status: string } },
    ]>;
    expect(updates.at(-1)?.[0].data).toMatchObject({ enabled: false, status: "ReconciliationFailed" });
  });

  it("recovers a remote grant using its persisted Pending intent after process interruption", async () => {
    const f = fixture();
    f.prisma.tenantMembership.findMany.mockResolvedValue([{ userId: "u1", status: MembershipStatus.Active,
      user: { identities: [{ issuer: nativeIssuer, providerType: "zitadel", externalSubject: "native-u1", identityProviderId: null }] },
    }]);
    f.prisma.tenantOidcGrant.findMany.mockResolvedValue([{ id: "pending-row", tenantId, userId: "u1",
      zitadelUserId: "native-u1", zitadelGrantId: null, status: "Pending" }]);
    f.project.findExistingMemberGrant.mockResolvedValue("upstream-existing-grant");
    await f.service.reconcileGrants(tenantId);
    expect(f.project.assignMember).not.toHaveBeenCalled();
    expect(f.prisma.tenantOidcGrant.create).not.toHaveBeenCalled();
    expect(f.prisma.tenantOidcGrant.update).toHaveBeenCalledWith({
      where: { id: "pending-row" }, data: { zitadelGrantId: "upstream-existing-grant", status: "Active" },
    });
  });

  it("finds an orphaned pending grant during disable and revokes it before deleting its local intent", async () => {
    const f = fixture();
    f.prisma.tenantOidcGrant.findMany.mockResolvedValue([{ id: "pending-row", tenantId, userId: "u1",
      zitadelUserId: "native-u1", zitadelGrantId: null, status: "Pending" }]);
    f.project.findExistingMemberGrant.mockResolvedValue("orphan-remote");
    await f.service.disable(tenantId);
    expect(f.project.revokeMember).toHaveBeenCalledWith("native-u1", "orphan-remote");
    expect(f.prisma.tenantOidcGrant.delete).toHaveBeenCalledWith({ where: { id: "pending-row" } });
  });

});
