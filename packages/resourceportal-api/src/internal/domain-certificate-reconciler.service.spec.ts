import { CertificateStatus, DnsStatus, DomainType, CustomRootDomainVerificationStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import { DomainCertificateReconcilerService } from "./domain-certificate-reconciler.service";
import {
  ObservedCertificate,
  TraefikCertificateObserverService,
} from "./traefik-certificate-observer.service";

type UpdateInput = {
  where: { id: string };
  data: Record<string, unknown>;
};

type AuditCreateInput = {
  data: Record<string, unknown>;
};

type ObserveFn = (hostname: string) => Promise<ObservedCertificate>;

function assignedDomain(
  protocolMode: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    tenantId: "22222222-2222-4222-8222-222222222222",
    tenant: { name: "tenant" },
    hostname: "app.example.com",
    tlsEnabled: false,
    certificateStatus: CertificateStatus.Pending,
    certificateIssuer: null,
    certificateExpiresAt: null,
    httpEndpoint: { protocolMode },
    ...overrides,
  };
}

function serviceFor(domains: Array<Record<string, unknown>>, observeFn: ObserveFn) {
  const update = vi.fn((input: UpdateInput) =>
    Promise.resolve({ id: input.where.id, ...input.data }),
  );
  const auditCreate = vi.fn((input: AuditCreateInput) => Promise.resolve(input));
  const tx = {
    domain: { update },
    auditLogEntry: { create: auditCreate },
  };
  const prisma = {
    domain: {
      findMany: vi.fn().mockResolvedValue(domains),
      findFirst: vi.fn().mockResolvedValue(domains[0] ?? null),
      update,
    },
    auditLogEntry: { create: auditCreate },
    $transaction: vi.fn((callback: (client: typeof tx) => Promise<unknown>) =>
      callback(tx),
    ),
  };
  const observer = {
    observe: vi.fn(observeFn),
  };

  return {
    auditCreate,
    prisma,
    observer,
    service: new DomainCertificateReconcilerService(
      prisma as unknown as PrismaService,
      observer as unknown as TraefikCertificateObserverService,
    ),
  };
}

function updateData(update: ReturnType<typeof serviceFor>["prisma"]["domain"]["update"]) {
  return update.mock.calls[0]?.[0]?.data;
}

describe("DomainCertificateReconcilerService", () => {
  it("marks an observed unexpired certificate Active and records a system audit event", async () => {
    const domain = assignedDomain("HTTPS");
    const expiresAt = new Date(Date.now() + 86_400_000);
    const { auditCreate, prisma, service } = serviceFor([domain], () =>
      Promise.resolve({
        hostname: "app.example.com",
        domains: ["app.example.com"],
        expiresAt,
        issuer: "R12",
      }),
    );

    const result = await service.reconcileBatch();

    expect(prisma.domain.update.mock.calls[0]?.[0]?.where).toEqual({
      id: domain.id,
    });
    expect(updateData(prisma.domain.update)).toMatchObject({
      tlsEnabled: true,
      certificateStatus: CertificateStatus.Active,
      certificateIssuer: "R12",
      certificateExpiresAt: expiresAt,
      updatedBy: "system",
    });
    expect(auditCreate.mock.calls[0]?.[0]?.data).toMatchObject({
      tenantId: domain.tenantId,
      tenantName: "tenant",
      actor: "system",
      actorName: "Certificate Reconciler",
      action: "domain.certificate.renew",
      resourceType: "Domain",
      resourceId: domain.id,
      resourceName: domain.hostname,
      result: "Success",
    });
    expect(result).toEqual({ checked: 1, updated: 1, failed: 0 });
  });

  it("normalizes HTTP domains to no-TLS metadata without observing them", async () => {
    const domain = assignedDomain("HTTP", {
      tlsEnabled: true,
      certificateStatus: CertificateStatus.Active,
      certificateIssuer: "R12",
      certificateExpiresAt: new Date(Date.now() + 86_400_000),
    });
    const { prisma, observer, service } = serviceFor([domain], () =>
      Promise.reject(new Error("must not observe")),
    );

    await service.reconcileBatch();

    expect(observer.observe).not.toHaveBeenCalled();
    expect(updateData(prisma.domain.update)).toMatchObject({
      tlsEnabled: false,
      certificateStatus: CertificateStatus.Pending,
      certificateIssuer: null,
      certificateExpiresAt: null,
      updatedBy: "system",
    });
  });

  it("keeps initial TLS issuance in Issuing state and audits the failed observation", async () => {
    const domain = assignedDomain("HTTP_REDIRECT_TO_HTTPS", {
      certificateStatus: CertificateStatus.Pending,
    });
    const { auditCreate, prisma, service } = serviceFor([domain], () =>
      Promise.reject(new Error("ECONNREFUSED")),
    );

    const result = await service.reconcileBatch();

    expect(updateData(prisma.domain.update)).toMatchObject({
      tlsEnabled: true,
      certificateStatus: CertificateStatus.Issuing,
      certificateExpiresAt: null,
      updatedBy: "system",
    });
    expect(auditCreate.mock.calls[0]?.[0]?.data).toMatchObject({
      actor: "system",
      actorName: "Certificate Reconciler",
      action: "domain.certificate.renew",
      result: "Failed",
      errorCode: "CertificateObservationFailed",
      errorMessage: "ECONNREFUSED",
    });
    expect(result).toEqual({ checked: 1, updated: 1, failed: 1 });
  });

  it("marks a previously Active certificate Error when observation fails", async () => {
    const domain = assignedDomain("HTTPS", {
      certificateStatus: CertificateStatus.Active,
    });
    const { prisma, service } = serviceFor([domain], () =>
      Promise.reject(new Error("TLS failed")),
    );

    await service.reconcileBatch();

    expect(updateData(prisma.domain.update)).toMatchObject({
      tlsEnabled: true,
      certificateStatus: CertificateStatus.Error,
      updatedBy: "system",
    });
  });

  it("recovers a tenant-owned Error domain on a verified ingress observation", async () => {
    const domain = assignedDomain("HTTPS", {
      dnsStatus: DnsStatus.Valid,
      type: DomainType.Custom,
      certificateStatus: CertificateStatus.Error,
      customRootDomain: {
        tenantId: "22222222-2222-4222-8222-222222222222",
        rootDomain: "example.com",
        verificationStatus: CustomRootDomainVerificationStatus.Verified,
      },
    });
    const { service, prisma } = serviceFor([domain], hostname => Promise.resolve({
      hostname, domains: [hostname], expiresAt: new Date(Date.now() + 86_400_000),
    }));
    const result = await service.reconcileTenantDomain(domain.tenantId, domain.id);
    expect(result.failed).toBe(0);
    expect(prisma.domain.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: domain.id, tenantId: domain.tenantId },
    }));
    expect(updateData(prisma.domain.update)?.certificateStatus).toBe("Active");
  });

  it("blocks recovery for unverified legacy domains before observing TLS", async () => {
    const domain = assignedDomain("HTTPS", { dnsStatus: DnsStatus.Valid, type: DomainType.Custom, customRootDomain: null });
    const { service, observer } = serviceFor([domain], hostname => Promise.resolve({
      hostname, domains: [hostname], expiresAt: new Date(Date.now() + 86_400_000),
    }));
    await expect(service.reconcileTenantDomain(domain.tenantId, domain.id)).rejects.toThrow("DomainNotPublishable");
    expect(observer.observe).not.toHaveBeenCalled();
  });

  it("keeps Error after a repeated failed observation instead of silently reverting to Issuing", async () => {
    const domain = assignedDomain("HTTPS", {
      type: DomainType.Managed, dnsStatus: DnsStatus.Valid,
      certificateStatus: CertificateStatus.Error,
      certificateExpiresAt: new Date("2027-01-01T00:00:00.000Z"),
    });
    const { service, prisma } = serviceFor([domain], () => Promise.reject(new Error("ACME timeout")));
    await service.reconcileBatch();
    expect(updateData(prisma.domain.update)?.certificateStatus).toBe(CertificateStatus.Error);
    expect(updateData(prisma.domain.update)?.certificateExpiresAt).toBeUndefined();
  });

  it("reports a failed explicit reconcile rather than a misleading succeeded operation", async () => {
    const domain = assignedDomain("HTTPS", {
      type: DomainType.Managed, dnsStatus: DnsStatus.Valid,
      certificateStatus: CertificateStatus.Error,
    });
    const { service } = serviceFor([domain], () => Promise.reject(new Error("ACME timeout")));
    await expect(service.reconcileTenantDomain(domain.tenantId, domain.id)).rejects.toThrow("ManagedIngressCertificateObservationFailed");
  });

  it("continues reconciling other domains after one observation failure", async () => {
    const first = assignedDomain("HTTPS", { id: "domain-1" });
    const second = assignedDomain("HTTPS", {
      id: "domain-2",
      hostname: "second.example.com",
    });
    const expiresAt = new Date(Date.now() + 86_400_000);
    const { auditCreate, prisma, service } = serviceFor(
      [first, second],
      (hostname) =>
        hostname === "app.example.com"
          ? Promise.reject(new Error("TLS failed"))
          : Promise.resolve({
              hostname,
              domains: [hostname],
              expiresAt,
              issuer: "R12",
            }),
    );

    const result = await service.reconcileBatch();

    expect(prisma.domain.update).toHaveBeenCalledTimes(2);
    expect(auditCreate).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ checked: 2, updated: 2, failed: 1 });
  });
});
