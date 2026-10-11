import { DomainType, DnsStatus, CustomRootDomainVerificationStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { DeploymentExecutionService } from "./deployment-execution.service";

describe("worker refuses to publish stale or unowned domains (#204)", () => {
  const tenantId = "tenant-a";
  const id = "domain-1";
  const snapshot = {
    appGroup: { tenantId },
    singleApps: [{
      httpEndpoints: [{
        name: "public", containerPort: 8080,
        domains: [{
          id, hostname: "app.example.com", dnsStatus: "Valid",
          tlsEnabled: false, certificateStatus: "Pending",
        }],
      }],
    }],
  };
  const verified = {
    id, type: DomainType.Custom, dnsStatus: DnsStatus.Valid,
    hostname: "app.example.com", tenantId,
    customRootDomain: {
      tenantId, rootDomain: "example.com",
      verificationStatus: CustomRootDomainVerificationStatus.Verified,
    },
  };

  function serviceFor(domain: object | undefined) {
    const prisma = {
      domain: { findMany: vi.fn().mockResolvedValue(domain ? [domain] : []) },
    };
    const service = Object.assign(Object.create(DeploymentExecutionService.prototype), { prisma }) as {
      validateDomains: (snapshot: object) => Promise<{ success: false; errorCode: string } | null>;
    };
    return { service, prisma };
  }

  it("denies old unowned domain records despite a formerly valid DNS snapshot", async () => {
    const { service } = serviceFor({ ...verified, customRootDomain: null });
    await expect(service.validateDomains(snapshot)).resolves.toMatchObject({
      success: false, errorCode: "DomainOwnershipNotVerified",
    });
  });
  it("denies cross-tenant ownership even if the hostname matches", async () => {
    const { service } = serviceFor({
      ...verified, customRootDomain: { ...verified.customRootDomain, tenantId: "tenant-b" },
    });
    await expect(service.validateDomains(snapshot)).resolves.toMatchObject({
      success: false, errorCode: "DomainOwnershipNotVerified",
    });
  });
  it("denies stale hostnames even if another verified domain has the old record ID", async () => {
    const { service } = serviceFor({ ...verified, hostname: "changed.example.com" });
    await expect(service.validateDomains(snapshot)).resolves.toMatchObject({
      success: false, errorCode: "DomainOwnershipNotVerified",
    });
  });
  it("permits verified and current tenant-owned domains", async () => {
    const { service, prisma } = serviceFor(verified);
    await expect(service.validateDomains(snapshot)).resolves.toBeNull();
    expect(prisma.domain.findMany).toHaveBeenCalledWith({
      where: { id: { in: [id] }, tenantId },
      include: { customRootDomain: true },
    });
  });
});
