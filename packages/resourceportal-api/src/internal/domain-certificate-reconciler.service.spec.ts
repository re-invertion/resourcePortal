import { CertificateStatus } from "@prisma/client";
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

type ObserveFn = (hostname: string) => Promise<ObservedCertificate>;

function assignedDomain(
  protocolMode: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
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
  const prisma = {
    domain: {
      findMany: vi.fn().mockResolvedValue(domains),
      update,
    },
  };
  const observer = {
    observe: vi.fn(observeFn),
  };

  return {
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
  it("marks an observed unexpired certificate Active and stores expiry/issuer metadata", async () => {
    const domain = assignedDomain("HTTPS");
    const expiresAt = new Date(Date.now() + 86_400_000);
    const { prisma, service } = serviceFor([domain], () =>
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

  it("keeps initial TLS issuance in Issuing state when a certificate is not observable yet", async () => {
    const domain = assignedDomain("HTTP_REDIRECT_TO_HTTPS", {
      certificateStatus: CertificateStatus.Pending,
    });
    const { prisma, service } = serviceFor([domain], () =>
      Promise.reject(new Error("ECONNREFUSED")),
    );

    const result = await service.reconcileBatch();

    expect(updateData(prisma.domain.update)).toMatchObject({
      tlsEnabled: true,
      certificateStatus: CertificateStatus.Issuing,
      certificateExpiresAt: null,
      updatedBy: "system",
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

  it("continues reconciling other domains after one observation failure", async () => {
    const first = assignedDomain("HTTPS", { id: "domain-1" });
    const second = assignedDomain("HTTPS", {
      id: "domain-2",
      hostname: "second.example.com",
    });
    const expiresAt = new Date(Date.now() + 86_400_000);
    const { prisma, service } = serviceFor([first, second], (hostname) =>
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
    expect(result).toEqual({ checked: 2, updated: 2, failed: 1 });
  });
});
