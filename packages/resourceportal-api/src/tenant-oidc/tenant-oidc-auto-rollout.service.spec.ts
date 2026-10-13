import { describe, expect, it, vi } from "vitest";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { TenantOidcService } from "./tenant-oidc.service";
import { TenantOidcAutoRolloutService } from "./tenant-oidc-auto-rollout.service";

const issuer = "https://auth.example.test";
const native = {
  user: {
    identities: [{
      issuer,
      providerType: "zitadel",
      identityProviderId: null,
    }],
  },
};

function fixture(overrides: Record<string, string> = {}) {
  const config = new ConfigService({
    TENANT_OIDC_AUTO_ROLLOUT: "true",
    TENANT_OIDC_ACTIVATION_ALLOWED: "false",
    ZITADEL_MANAGEMENT_TOKEN: "test-token",
    ZITADEL_ORGANIZATION_ID: "test-org",
    OIDC_ISSUER_URL: issuer,
    ...overrides,
  });
  const prisma = {
    identityProvider: { count: vi.fn().mockResolvedValue(0) },
    userIdentity: { count: vi.fn().mockResolvedValue(0) },
    tenantAuthPolicy: { count: vi.fn().mockResolvedValue(0) },
    portalSession: { count: vi.fn().mockResolvedValue(0) },
    tenant: {
      findMany: vi.fn().mockResolvedValue([{ id: "t1" }]),
      count: vi.fn().mockResolvedValue(1),
    },
    tenantMembership: { findMany: vi.fn().mockResolvedValue([native]) },
    oAuthApplication: { count: vi.fn().mockResolvedValue(0) },
    tenantOidcProvider: {
      findUnique: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
      upsert: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const oidc = {
    provision: vi.fn().mockResolvedValue({ enabled: false }),
    reconcileGrants: vi.fn().mockResolvedValue({ enabled: false }),
    activate: vi.fn().mockResolvedValue({ enabled: true }),
    disable: vi.fn().mockResolvedValue({ enabled: false }),
    verifyIssuerSecurity: vi.fn().mockResolvedValue(undefined),
  };
  const service = new TenantOidcAutoRolloutService(
    prisma as unknown as PrismaService,
    oidc as unknown as TenantOidcService,
    config,
  );
  return { service, prisma, oidc };
}

describe("Tenant OIDC automatic rollout", () => {
  it("remains inert when disabled", async () => {
    const f = fixture({ TENANT_OIDC_AUTO_ROLLOUT: "false" });
    expect(await f.service.reconcile()).toMatchObject({ state: "disabled" });
    expect(f.prisma.tenant.findMany).not.toHaveBeenCalled();
  });

  it("blocks all tenant cutovers if any inbound federation exists", async () => {
    const f = fixture();
    f.prisma.userIdentity.count.mockResolvedValue(1);
    const result = await f.service.reconcile();
    expect(result).toMatchObject({
      state: "blocked-inbound-federation",
      blockerCounts: { externalAccounts: 1 },
    });
    expect(f.oidc.provision).not.toHaveBeenCalled();
  });

  it("requires real management configuration and HTTPS issuer", async () => {
    const f = fixture({ OIDC_ISSUER_URL: "http://insecure.test" });
    expect(await f.service.reconcile()).toMatchObject({
      state: "blocked-zitadel-configuration",
    });
    expect(f.oidc.provision).not.toHaveBeenCalled();
  });

  it("prepares project/grants, but never activates before live certification", async () => {
    const f = fixture();
    const result = await f.service.reconcile();
    expect(result).toMatchObject({ state: "prepared", attempted: 1, prepared: 1, activated: 0 });
    expect(f.oidc.provision).toHaveBeenCalledWith("t1");
    expect(f.oidc.reconcileGrants).toHaveBeenCalledWith("t1");
    expect(f.oidc.activate).not.toHaveBeenCalled();
  });

  it("activates only when independent live certification gate is enabled", async () => {
    const f = fixture({ TENANT_OIDC_ACTIVATION_ALLOWED: "true" });
    expect(await f.service.reconcile()).toMatchObject({ state: "active", activated: 1 });
    expect(f.oidc.activate).toHaveBeenCalledWith("t1", true);
  });

  it("does not break old clients on the platform project", async () => {
    const f = fixture({ TENANT_OIDC_ACTIVATION_ALLOWED: "true" });
    f.prisma.oAuthApplication.count.mockResolvedValue(2);
    expect(await f.service.reconcile()).toMatchObject({ state: "partial", blocked: 1 });
    expect(f.oidc.provision).not.toHaveBeenCalled();
  });

  it("does not guess native users from email or upstream identities", async () => {
    const f = fixture();
    f.prisma.tenantMembership.findMany.mockResolvedValue([{
      user: { identities: [{ ...native.user.identities[0], identityProviderId: "upstream" }] },
    }]);
    expect(await f.service.reconcile()).toMatchObject({ state: "partial", blocked: 1 });
    expect(f.oidc.provision).not.toHaveBeenCalled();
  });

  it("does not acquire a second worker's migration lease", async () => {
    const f = fixture();
    f.prisma.tenantOidcProvider.updateMany.mockResolvedValue({ count: 0 });
    expect(await f.service.reconcile()).toMatchObject({ attempted: 0 });
    expect(f.oidc.provision).not.toHaveBeenCalled();
  });

  it("skips already-active tenants on next reconciliation", async () => {
    const f = fixture();
    f.prisma.tenantOidcProvider.findUnique.mockResolvedValue({
      enabled: true, status: "Active",
    });
    expect(await f.service.reconcile()).toMatchObject({ attempted: 0 });
    expect(f.oidc.reconcileGrants).not.toHaveBeenCalled();
  });

  it("leaves a broken tenant disabled and keeps reconciling other tenants", async () => {
    const f = fixture();
    f.prisma.tenant.findMany.mockResolvedValue([{ id: "t1" }, { id: "t2" }]);
    f.oidc.provision.mockRejectedValueOnce(new Error("ZITADEL temporarily unavailable"));
    const result = await f.service.reconcile();
    expect(result).toMatchObject({ state: "partial", blocked: 1, prepared: 1 });
    expect(f.oidc.activate).not.toHaveBeenCalled();
  });

  it("automatically activates after verifying all tenants with no manual flag", async () => {
    const f = fixture({ TENANT_OIDC_ACTIVATION_ALLOWED: "auto" });
    const result = await f.service.reconcile();
    expect(result).toMatchObject({ state: "active", attempted: 1, activated: 1, blocked: 0 });
    expect(f.oidc.activate).toHaveBeenCalledWith("t1", true);
  });

  it("never activates a single tenant when any other tenant is blocked", async () => {
    const f = fixture({ TENANT_OIDC_ACTIVATION_ALLOWED: "auto" });
    f.prisma.tenant.findMany.mockResolvedValue([{ id: "t1" }, { id: "t2" }]);
    f.prisma.oAuthApplication.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    const result = await f.service.reconcile();
    expect(result).toMatchObject({ state: "partial", prepared: 1, blocked: 1, activated: 0 });
    expect(f.oidc.activate).not.toHaveBeenCalled();
  });

  it("disables every newly activated tenant if later cohort activation fails", async () => {
    const f = fixture({ TENANT_OIDC_ACTIVATION_ALLOWED: "auto" });
    f.prisma.tenant.findMany.mockResolvedValue([{ id: "t1" }, { id: "t2" }]);
    f.oidc.activate.mockResolvedValueOnce({ enabled: true })
      .mockRejectedValueOnce(new Error("upstream unavailable"));
    const result = await f.service.reconcile();
    expect(result).toMatchObject({ state: "partial", blocked: 1, activated: 0 });
    expect(f.oidc.disable).toHaveBeenCalledWith("t1");
  });

  it("reports read-only readiness only after every active tenant has active SSO", async () => {
    const f = fixture({ TENANT_OIDC_ACTIVATION_ALLOWED: "auto" });
    expect(await f.service.readiness()).toEqual({ status: "pending" });
    expect(f.oidc.verifyIssuerSecurity).not.toHaveBeenCalled();
    f.prisma.tenantOidcProvider.count.mockResolvedValue(1);
    expect(await f.service.readiness()).toEqual({ status: "ready" });
    expect(f.oidc.verifyIssuerSecurity).toHaveBeenCalledOnce();
    f.prisma.userIdentity.count.mockResolvedValue(1);
    expect(await f.service.readiness()).toEqual({ status: "blocked" });
  });
});
