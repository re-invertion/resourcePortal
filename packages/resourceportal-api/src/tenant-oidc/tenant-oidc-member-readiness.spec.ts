import { describe, expect, it, vi } from "vitest";
import { TenantOidcService } from "./tenant-oidc.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { ZitadelTenantProjectService } from "./zitadel-tenant-project.service";

const tenantId = "ddf51039-70da-4c2a-a9e1-68843de4c2d3";
const userId = "a205ac53-b3ad-4f4b-9dba-f77084e4f111";
const identity = {
  providerType: "zitadel", identityProviderId: null,
  issuer: "https://issuer.example", externalSubject: "123456",
};

function setup(grant: unknown, providerStatus = "Active") {
  const verifyMemberGrant = vi.fn().mockResolvedValue(undefined);
  const prisma = {
    tenantMembership: { findUnique: vi.fn().mockResolvedValue({
      status: "Active",
      user: { status: "Active", identities: [identity] },
      roles: [{ roleId: "sso-login" }], groupMemberships: [],
    }) },
    tenantOidcProvider: { findUnique: vi.fn().mockResolvedValue({
      status: providerStatus, enabled: providerStatus === "Active",
      issuer: "https://issuer.example", zitadelProjectId: "project-1",
      lastErrorCode: providerStatus === "ReconciliationFailed" ? "GRANT_SYNC_FAILED" : null,
    }) },
    tenantOidcGrant: { findFirst: vi.fn().mockResolvedValue(grant) },
  };
  const zitadel = { issuer: "https://issuer.example", verifyMemberGrant };
  const service = new TenantOidcService(
    prisma as unknown as PrismaService,
    zitadel as unknown as ZitadelTenantProjectService,
  );
  return { service, prisma, verifyMemberGrant };
}

describe("tenant SSO onboarding readiness (#463)", () => {
  it("does not treat a persisted exact-client entitlement as upstream readiness", async () => {
    const { service, verifyMemberGrant } = setup(null);
    expect(await service.memberReadiness(tenantId, userId)).toEqual({
      status: "pending", reason: "UPSTREAM_GRANT_PENDING",
    });
    expect(verifyMemberGrant).not.toHaveBeenCalled();
  });

  it("requires an active grant bound to the correct native subject and project", async () => {
    const { service, verifyMemberGrant } = setup({
      status: "Active", zitadelUserId: "123456", zitadelGrantId: "grant-1",
    });
    expect(await service.memberReadiness(tenantId, userId)).toEqual({ status: "ready" });
    expect(verifyMemberGrant).toHaveBeenCalledWith("123456", "grant-1", "project-1");
  });

  it("does not report ready when upstream verification fails", async () => {
    const { service, verifyMemberGrant } = setup({
      status: "Active", zitadelUserId: "123456", zitadelGrantId: "grant-1",
    });
    verifyMemberGrant.mockRejectedValue(new Error("upstream missing"));
    expect(await service.memberReadiness(tenantId, userId)).toEqual({
      status: "pending", reason: "UPSTREAM_GRANT_UNVERIFIED",
    });
  });

  it("exposes sanitized actionable provisioning failure without granting access", async () => {
    const { service } = setup(null, "ReconciliationFailed");
    expect(await service.memberReadiness(tenantId, userId)).toEqual({
      status: "blocked", reason: "GRANT_SYNC_FAILED",
    });
  });

  it("never promotes a foreign-subject grant to ready", async () => {
    const { service, verifyMemberGrant } = setup({
      status: "Active", zitadelUserId: "999999", zitadelGrantId: "grant-1",
    });
    expect((await service.memberReadiness(tenantId, userId)).status).toBe("pending");
    expect(verifyMemberGrant).not.toHaveBeenCalled();
  });
});
