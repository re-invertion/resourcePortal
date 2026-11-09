import { ConfigService } from "@nestjs/config";
import { CertificateStatus, CustomRootDomainVerificationStatus, DnsStatus, DomainType } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import { DomainsService } from "./domains.service";

const tenantId = "22222222-2222-4222-8222-222222222222";
const domainId = "11111111-1111-4111-8111-111111111111";
const domain = {
  id: domainId, tenantId, hostname: "app.example.com", type: DomainType.Custom,
  dnsStatus: DnsStatus.Valid, certificateStatus: CertificateStatus.Error,
  certificateExpiresAt: new Date("2027-01-01T00:00:00.000Z"),
  certificateIssuer: "R12", tlsEnabled: true,
  customRootDomain: { tenantId, rootDomain: "example.com", verificationStatus: CustomRootDomainVerificationStatus.Verified },
  httpEndpoint: { protocolMode: "HTTPS" },
};

function fixture(entry: Record<string, unknown> | null = null) {
  const prisma = {
    domain: { findFirst: vi.fn().mockResolvedValue(domain) },
    auditLogEntry: { findFirst: vi.fn().mockResolvedValue(entry) },
  };
  const service = new DomainsService(
    prisma as unknown as PrismaService,
    { get: vi.fn() } as unknown as ConfigService,
  );
  return { prisma, service };
}

describe("tenant TLS certificate diagnostics (#414)", () => {
  it("returns sanitized last worker failure without exposing raw observer error", async () => {
    const x = fixture({
      timestamp: new Date("2026-11-08T14:00:00.000Z"), result: "Failed",
      errorCode: "CertificateObservationFailed", errorMessage: "secret-internal-endpoint",
    });
    const result = await x.service.getCertificateDiagnostics(tenantId, domainId);
    expect(result).toMatchObject({
      certificateStatus: "Error", dnsStatus: "Valid", transient: true,
      errorCode: "CertificateObservationFailed", observationSource: "ManagedSwarmIngress",
      canReconcile: true, deploymentBlocked: true, ingressPublication: "NotVerified",
    });
    expect(JSON.stringify(result)).not.toContain("secret-internal-endpoint");
    expect(x.prisma.auditLogEntry.findFirst).toHaveBeenCalledWith({
      where: {
        tenantId, resourceType: "Domain", resourceId: domainId,
        action: "domain.certificate.renew",
      },
      orderBy: { timestamp: "desc" },
      select: { timestamp: true, result: true, errorCode: true },
    });
  });

  it("displays a valid last worker observation without conflating TLS and ingress publication", async () => {
    const x = fixture({ timestamp: new Date(), result: "Success", errorCode: null });
    x.prisma.domain.findFirst.mockResolvedValue({ ...domain, certificateStatus: CertificateStatus.Active });
    const result = await x.service.getCertificateDiagnostics(tenantId, domainId);
    expect(result).toMatchObject({
      observationStatus: "Succeeded", transient: false, cause: null,
      deploymentBlocked: false, ingressPublication: "NotVerified",
    });
  });

  it("denies another tenant's record without querying audit history", async () => {
    const x = fixture();
    x.prisma.domain.findFirst.mockResolvedValue(null);
    await expect(x.service.getCertificateDiagnostics(tenantId, domainId)).rejects.toThrow();
    expect(x.prisma.auditLogEntry.findFirst).not.toHaveBeenCalled();
  });
});
