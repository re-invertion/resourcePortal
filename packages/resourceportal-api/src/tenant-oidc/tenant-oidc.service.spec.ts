import { MembershipStatus, TenantStatus, UserStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../prisma/prisma.service";
import { TenantOidcService } from "./tenant-oidc.service";
import type { ZitadelTenantProjectService } from "./zitadel-tenant-project.service";

const tenantId = "tenant-a";
const nativeIssuer = "https://auth.example.com";

function fixture() {
  const project = {
    issuer: nativeIssuer,
    createProject: vi.fn().mockResolvedValue("123"),
    readProject: vi.fn().mockResolvedValue({
      id: "123", projectRoleCheck: true, hasProjectCheck: true,
    }),
    ensureMemberRole: vi.fn().mockResolvedValue(undefined),
    assignMember: vi.fn().mockResolvedValue("grant-new"),
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
    _count: { grants: 0 },
  };
  const prisma = {
    tenant: { findUnique: vi.fn().mockResolvedValue({ status: TenantStatus.Active }) },
    tenantOidcProvider: {
      upsert: vi.fn().mockResolvedValue({ ...provider, zitadelProjectId: null }),
      findUnique: vi.fn().mockResolvedValue(provider),
      update: vi.fn().mockResolvedValue(provider),
    },
    tenantMembership: { findMany: vi.fn().mockResolvedValue([]) },
    oAuthApplication: { count: vi.fn().mockResolvedValue(0) },
    tenantOidcGrant: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
  };
  const service = new TenantOidcService(
    prisma as unknown as PrismaService,
    project as unknown as ZitadelTenantProjectService,
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
    expect(f.prisma.tenantOidcProvider.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({
        status: "GrantsReconciled", enabled: false,
      }) as unknown as Record<string, unknown> }),
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
    expect(f.prisma.tenantOidcProvider.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({
        status: "ReconciliationFailed", enabled: false,
      }) as unknown as Record<string, unknown> }),
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
      where: { tenantId },
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
      data: { tenantId: tenantB, userId: "user-b", zitadelUserId: "zitadel-user-b", zitadelGrantId: "grant-new", status: "Active" },
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
    expect(f.prisma.tenantOidcProvider.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ enabled: false, status: "ReconciliationFailed" }) as Record<string, unknown> }),
    );
  });

  it("does not activate without a certified rollout gate", async () => {
    const f = fixture();
    await expect(f.service.activate(tenantId)).rejects.toThrow("disabled until live E2E");
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
        tenantId, userId: "u1", zitadelUserId: "zitadel-u1", zitadelGrantId: "grant-new",
        status: "Active",
      },
    });
  });
});
