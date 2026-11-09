import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { CertificateStatus } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { isDomainPublishable } from "../domains/domain-publication";
import { protocolModeRequiresTls } from "./traefik-routing";
import { certificateCoversHostname, TraefikCertificateObserverService } from "./traefik-certificate-observer.service";

@Injectable()
export class DomainCertificateReconcilerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly observer: TraefikCertificateObserverService,
  ) {}

  async reconcileTenantDomain(tenantId: string, domainId: string) {
    const domain = await this.prisma.domain.findFirst({
      where: { id: domainId, tenantId },
      include: {
        customRootDomain: true,
        httpEndpoint: { select: { protocolMode: true } },
      },
    });
    // A tenant cannot use the repair endpoint to probe unverified/foreign hosts.
    if (!domain || !isDomainPublishable(domain, tenantId)) {
      throw new NotFoundException("DomainNotPublishable");
    }
    if (!domain.httpEndpoint || !protocolModeRequiresTls(domain.httpEndpoint.protocolMode)) {
      throw new ConflictException("DomainTlsNotRequired");
    }
    const result = await this.reconcileBatch({ tenantId, domainId });
    if (result.checked !== 1) {
      throw new NotFoundException("DomainNotPublishable");
    }
    if (result.failed) {
      throw new Error("ManagedIngressCertificateObservationFailed");
    }
    return result;
  }

  async reconcileBatch(filter?: { tenantId: string; domainId: string }) {
    const domains = await this.prisma.domain.findMany({
      ...(filter ? { where: { id: filter.domainId, tenantId: filter.tenantId } } : {}),
      include: {
        tenant: {
          select: { name: true },
        },
        httpEndpoint: {
          select: { protocolMode: true },
        },
        customRootDomain: true,
      },
    });

    let updated = 0;
    let failed = 0;

    for (const domain of domains) {
      // Ownership may be revoked between queue admission and worker execution.
      if (filter && !isDomainPublishable(domain, filter.tenantId)) {
        throw new NotFoundException("DomainNotPublishable");
      }
      const tlsRequired = domain.httpEndpoint
        ? protocolModeRequiresTls(domain.httpEndpoint.protocolMode)
        : false;
      if (filter && !tlsRequired) {
        // Attachment/protocol may have changed after queue admission.
        throw new ConflictException("DomainTlsNotRequired");
      }

      if (!tlsRequired) {
        await this.prisma.domain.update({
          where: { id: domain.id },
          data: {
            tlsEnabled: false,
            certificateStatus: CertificateStatus.Pending,
            certificateIssuer: null,
            certificateExpiresAt: null,
            updatedBy: "system",
          },
        });
        updated += 1;
        continue;
      }

      let observed;
      try {
        observed = await this.observer.observe(domain.hostname);
      } catch (error) {
        failed += 1;
        const certificateStatus =
          domain.certificateStatus === CertificateStatus.Active ||
          domain.certificateStatus === CertificateStatus.Error
            ? CertificateStatus.Error
            : CertificateStatus.Issuing;
        const errorMessage = this.errorMessage(error);

        await this.prisma.$transaction(async (tx) => {
          await tx.domain.update({
            where: { id: domain.id },
            data: {
              tlsEnabled: true,
              certificateStatus,
              // Preserve previously observed expiry across transport failures.
              // Initial issuance still explicitly starts without expiry metadata.
              certificateExpiresAt: domain.certificateStatus === CertificateStatus.Pending
                ? null : undefined,
              updatedBy: "system",
            },
          });
          await tx.auditLogEntry.create({
            data: {
              tenantId: domain.tenantId,
              tenantName: domain.tenant.name,
              actor: "system",
              actorName: "Certificate Reconciler",
              action: "domain.certificate.renew",
              resourceType: "Domain",
              resourceId: domain.id,
              resourceName: domain.hostname,
              result: "Failed",
              errorCode: "CertificateObservationFailed",
              errorMessage,
              requestId: null,
              correlationId: randomUUID(),
              ipAddress: null,
              userAgent: null,
              changes: {
                before: {
                  certificateStatus: domain.certificateStatus,
                  certificateIssuer: domain.certificateIssuer,
                  certificateExpiresAt: domain.certificateExpiresAt,
                },
                after: {
                  certificateStatus,
                  certificateExpiresAt: domain.certificateExpiresAt,
                },
              },
            },
          });
        });
        updated += 1;
        continue;
      }

      const coversHostname = certificateCoversHostname(
        observed.domains,
        domain.hostname,
      );
      const active =
        coversHostname && observed.expiresAt.getTime() > Date.now();
      const certificateStatus = active
        ? CertificateStatus.Active
        : CertificateStatus.Error;
      const errorCode = active ? null : "CertificateInvalid";
      const errorMessage = active
        ? null
        : "Observed certificate is expired or does not cover the hostname";

      await this.prisma.$transaction(async (tx) => {
        await tx.domain.update({
          where: { id: domain.id },
          data: {
            tlsEnabled: true,
            certificateStatus,
            certificateIssuer: observed.issuer ?? null,
            certificateExpiresAt: observed.expiresAt,
            updatedBy: "system",
          },
        });
        await tx.auditLogEntry.create({
          data: {
            tenantId: domain.tenantId,
            tenantName: domain.tenant.name,
            actor: "system",
            actorName: "Certificate Reconciler",
            action: "domain.certificate.renew",
            resourceType: "Domain",
            resourceId: domain.id,
            resourceName: domain.hostname,
            result: active ? "Success" : "Failed",
            errorCode,
            errorMessage,
            requestId: null,
            correlationId: randomUUID(),
            ipAddress: null,
            userAgent: null,
            changes: {
              before: {
                certificateStatus: domain.certificateStatus,
                certificateIssuer: domain.certificateIssuer,
                certificateExpiresAt: domain.certificateExpiresAt,
              },
              after: {
                certificateStatus,
                certificateIssuer: observed.issuer ?? null,
                certificateExpiresAt: observed.expiresAt,
              },
            },
          },
        });
      });
      updated += 1;
      if (!active) {
        failed += 1;
      }
    }

    return { checked: domains.length, updated, failed };
  }

  private errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}
