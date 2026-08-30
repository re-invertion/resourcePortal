import { Injectable } from "@nestjs/common";
import { CertificateStatus } from "@prisma/client";
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

      try {
        const observed = await this.observer.observe(domain.hostname);
        const coversHostname = this.coversHostname(
          observed.domains,
          domain.hostname,
        );
        const active =
          coversHostname && observed.expiresAt.getTime() > Date.now();

        await this.prisma.domain.update({
          where: { id: domain.id },
          data: {
            tlsEnabled: true,
            certificateStatus: active
              ? CertificateStatus.Active
              : CertificateStatus.Error,
            certificateIssuer: observed.issuer ?? null,
            certificateExpiresAt: observed.expiresAt,
            updatedBy: "system",
          },
        });
        updated += 1;
        if (!active) {
          failed += 1;
        }
      } catch {
        failed += 1;
        await this.prisma.domain.update({
          where: { id: domain.id },
          data: {
            tlsEnabled: true,
            certificateStatus:
              domain.certificateStatus === CertificateStatus.Active
                ? CertificateStatus.Error
                : CertificateStatus.Issuing,
            certificateExpiresAt: null,
            updatedBy: "system",
          },
        });
        updated += 1;
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
}
