import { Injectable } from "@nestjs/common";
import { CertificateStatus } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { protocolModeRequiresTls } from "./traefik-routing";
import { TraefikCertificateObserverService } from "./traefik-certificate-observer.service";

@Injectable()
export class DomainCertificateReconcilerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly observer: TraefikCertificateObserverService,
  ) {}

  async reconcileBatch() {
    const domains = await this.prisma.domain.findMany({
      include: {
        tenant: {
          select: { name: true },
        },
        httpEndpoint: {
          select: { protocolMode: true },
        },
      },
    });

    let updated = 0;
    let failed = 0;

    for (const domain of domains) {
      const tlsRequired = domain.httpEndpoint
        ? protocolModeRequiresTls(domain.httpEndpoint.protocolMode)
        : false;

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
          domain.certificateStatus === CertificateStatus.Active
            ? CertificateStatus.Error
            : CertificateStatus.Issuing;
        const errorMessage = this.errorMessage(error);

        await this.prisma.$transaction(async (tx) => {
          await tx.domain.update({
            where: { id: domain.id },
            data: {
              tlsEnabled: true,
              certificateStatus,
              certificateExpiresAt: null,
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
                  certificateExpiresAt: null,
                },
              },
            },
          });
        });
        updated += 1;
        continue;
      }

      const coversHostname = this.coversHostname(
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

  private coversHostname(domains: string[], hostname: string) {
    const normalizedHostname = hostname.toLowerCase();
    return domains.some((domain) => {
      const normalizedDomain = domain.toLowerCase();
      if (normalizedDomain === normalizedHostname) {
        return true;
      }
      if (!normalizedDomain.startsWith("*.")) {
        return false;
      }
      const suffix = normalizedDomain.slice(1);
      if (!normalizedHostname.endsWith(suffix)) {
        return false;
      }
      const prefix = normalizedHostname.slice(0, -suffix.length);
      return prefix.length > 0 && !prefix.includes(".");
    });
  }

  private errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}
