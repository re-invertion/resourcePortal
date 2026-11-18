import { CustomRootDomainVerificationStatus, DnsStatus, DomainType } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { DeploymentExecutionService } from "./deployment-execution.service";

const tenantId = "tenant-a";
const id = "domain-1";
const hostname = "app.example.com";
const expiresAt = () => new Date(Date.now() + 86_400_000);

function fixture(snapshotStatus: string, currentStatus: string, overrides: Record<string, unknown> = {}) {
  const snapshot = {
    appGroup: { tenantId },
    singleApps: [{ httpEndpoints: [{
      name: "public", containerPort: 8080,
      domains: [{ id, hostname, dnsStatus: "Valid", tlsEnabled: true, certificateStatus: snapshotStatus }],
    }] }],
  };
  const record = {
    id, hostname, tenantId, type: DomainType.Custom,
    dnsStatus: DnsStatus.Valid, certificateStatus: currentStatus,
    certificateExpiresAt: currentStatus === "Active" ? expiresAt() : null,
    customRootDomain: {
      tenantId, rootDomain: "example.com",
      verificationStatus: CustomRootDomainVerificationStatus.Verified,
    },
    ...overrides,
  };
  const findMany = vi.fn().mockResolvedValue([record]);
  const observe = vi.fn().mockResolvedValue({
    hostname, domains: [hostname], expiresAt: expiresAt(), issuer: "R12",
  });
  const service = Object.assign(Object.create(DeploymentExecutionService.prototype), {
    prisma: { domain: { findMany } },
    certificateObserver: { observe },
  }) as { validateDomains: (snapshot: unknown) => Promise<{ errorCode: string; message: string } | null> };
  return { service, observe, findMany, snapshot };
}

describe("AppGroup managed-ingress TLS preflight (#414)", () => {
  it("accepts fresh current TLS metadata without probing when both sources are Active", async () => {
    const x = fixture("Active", "Active");
    await expect(x.service.validateDomains(x.snapshot)).resolves.toBeNull();
    expect(x.observe).not.toHaveBeenCalled();
  });

  it("recovers stale snapshot Error after a trusted managed ingress observation", async () => {
    const x = fixture("Error", "Active");
    await expect(x.service.validateDomains(x.snapshot)).resolves.toBeNull();
    expect(x.observe).toHaveBeenCalledWith(hostname);
    expect(x.findMany).toHaveBeenCalledWith({
      where: { id: { in: [id] }, tenantId }, include: { customRootDomain: true },
    });
  });

  it("allows recovery of current Error only with verified managed-ingress evidence", async () => {
    const x = fixture("Error", "Error");
    await expect(x.service.validateDomains(x.snapshot)).resolves.toBeNull();
  });

  it("denies a truly expired or hostname-mismatched ingress certificate", async () => {
    const x = fixture("Error", "Error");
    x.observe.mockResolvedValue({ hostname, domains: ["different.example.com"], expiresAt: expiresAt() });
    const failure = await x.service.validateDomains(x.snapshot);
    expect(failure).toMatchObject({ errorCode: "DomainUnavailable" });
    expect(failure?.message).toContain("hostname mismatch");
  });

  it("denies an expired certificate on the intended ingress", async () => {
    const x = fixture("Error", "Error");
    x.observe.mockResolvedValue({ hostname, domains: [hostname], expiresAt: new Date(Date.now() - 1000) });
    await expect(x.service.validateDomains(x.snapshot)).resolves.toMatchObject({ errorCode: "DomainUnavailable" });
  });

  it("fails closed on TLS observer timeout and does not mutate workload state", async () => {
    const x = fixture("Active", "Error");
    x.observe.mockRejectedValue(new Error("ETIMEDOUT"));
    const failure = await x.service.validateDomains(x.snapshot);
    expect(failure).toMatchObject({ errorCode: "DomainUnavailable" });
    expect(failure?.message).toContain("observation failed");
    expect(x.findMany).toHaveBeenCalledTimes(1);
  });

  it("denies even historical Active when the current domain is not authorized", async () => {
    const x = fixture("Active", "Active", { customRootDomain: null });
    await expect(x.service.validateDomains(x.snapshot)).resolves.toMatchObject({
      errorCode: "DomainOwnershipNotVerified",
    });
    expect(x.observe).not.toHaveBeenCalled();
  });

  it("checks current DNS, not stale snapshot state", async () => {
    const x = fixture("Active", "Active", { dnsStatus: DnsStatus.Invalid });
    await expect(x.service.validateDomains(x.snapshot)).resolves.toMatchObject({
      errorCode: "DomainOwnershipNotVerified",
    });
    expect(x.observe).not.toHaveBeenCalled();
  });

  it("denies a misconfigured worker without managed ingress evidence", async () => {
    const x = fixture("Error", "Error");
    const withoutObserver = Object.assign(Object.create(DeploymentExecutionService.prototype), {
      prisma: { domain: { findMany: x.findMany } },
    }) as { validateDomains: (snapshot: unknown) => Promise<{ errorCode: string } | null> };
    await expect(withoutObserver.validateDomains(x.snapshot)).resolves.toMatchObject({ errorCode: "DomainUnavailable" });
  });
});
