import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  CertificateStatus,
  CustomRootDomainVerificationStatus,
  DnsStatus,
  DomainType,
  Prisma,
} from "@prisma/client";
import crypto from "node:crypto";
import { resolve4, resolve6, resolveCname, resolveTxt } from "node:dns/promises";
import { AuthenticatedUser } from "../auth/types";
import { isDomainPublishable } from "./domain-publication";
import { protocolModeRequiresTls } from "../internal/traefik-routing";
import { PrismaService } from "../prisma/prisma.service";
import { ManagedDnsService } from "../platform-dns/managed-dns.service";
import { CloudflareTenantOauthService } from "../platform-dns/cloudflare-tenant-oauth.service";
import { CreateCustomRootDomainDto } from "./dto/create-custom-root-domain.dto";
import { CreateDomainDto } from "./dto/create-domain.dto";
import { UpdateCustomRootDomainDto } from "./dto/update-custom-root-domain.dto";
import { UpdateDomainDto } from "./dto/update-domain.dto";
import { mapCustomRootDomain, mapDomain } from "./domains.view";

@Injectable()
export class DomainsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly managedDns?: ManagedDnsService,
    private readonly tenantCloudflare?: CloudflareTenantOauthService,
  ) {}

  async listDomains(tenantId: string) {
    const domains = await this.prisma.domain.findMany({
      where: { tenantId },
      orderBy: { hostname: "asc" },
      include: this.domainIncludes(),
    });

    return domains.map(mapDomain);
  }

  async getDomain(tenantId: string, domainId: string) {
    const domain = await this.findDomainOrThrow(tenantId, domainId);
    return mapDomain(domain);
  }

  /** Tenant-scoped, read-only public DNS evidence; never implies route reachability. */
  async getDnsDiagnostics(tenantId: string, domainId: string) {
    const domain = await this.findDomainOrThrow(tenantId, domainId);
    const hostname = domain.hostname.toLowerCase().replace(/\.$/, "");
    const target = (this.managedDns?.getDomainTargetHostname() ??
      this.config.get<string>("RESOURCEPORTAL_PUBLIC_HOSTNAME", this.managedBaseDomain()))
      .trim().toLowerCase().replace(/\.$/, "");
    const base = { hostname, expected: { type: "CNAME", target },
      observed: { cname: [] as string[], a: [] as string[], aaaa: [] as string[] },
      status: "Unavailable" as "Unavailable" | "Matches" | "Mismatch" | "OwnershipUnverified",
      recommendation: "DNS observations are unavailable; retry after the resolver is available." };
    // Do not probe externally for hostnames whose tenant ownership is not proven.
    if (domain.type === DomainType.Custom && !isDomainPublishable(
      { ...domain, dnsStatus: DnsStatus.Valid }, tenantId)) {
      return { ...base, status: "OwnershipUnverified" as const,
        recommendation: "Verify ownership of a matching tenant root before checking public DNS." };
    }
    if (domain.type === DomainType.Managed) {
      return { ...base, status: "Unavailable" as const,
        recommendation: "This domain uses managed DNS. Check its managed DNS status instead." };
    }
    const query = async (resolver: (host: string) => Promise<string[]>, host: string) => {
      try { return { values: await resolver(host), available: true }; }
      catch (error) { return { values: [] as string[], available: (error as { code?: string }).code === "ENODATA" || (error as { code?: string }).code === "ENOTFOUND" }; }
    };
    const [cname, a, aaaa, targetA, targetAaaa] = await Promise.all([
      query(resolveCname, hostname), query(resolve4, hostname), query(resolve6, hostname),
      query(resolve4, target), query(resolve6, target),
    ]);
    const observed = {
      cname: cname.values.map(value => value.toLowerCase().replace(/\.$/, "")),
      a: a.values, aaaa: aaaa.values,
    };
    const directMatch = hostname === target || observed.cname.includes(target);
    const targetAddresses = new Set([...targetA.values, ...targetAaaa.values]);
    const flattenedMatch = targetAddresses.size > 0 && [...observed.a, ...observed.aaaa].some(address => targetAddresses.has(address));
    // A/AAAA flattening cannot be declared mismatched when the configured
    // target's address lookup failed: the public hostname may be correct.
    const hasObservedAddresses = observed.a.length > 0 || observed.aaaa.length > 0;
    const targetEvidenceAvailable = !hasObservedAddresses || (targetA.available && targetAaaa.available);
    const known = cname.available && a.available && aaaa.available && targetEvidenceAvailable;
    const status = directMatch || flattenedMatch ? "Matches" : known ? "Mismatch" : "Unavailable";
    return { ...base, observed, status,
      recommendation: status === "Matches" ? "Public DNS points at the configured target. Ingress reachability is not verified." :
        status === "Mismatch" ? `Set CNAME ${hostname} to ${target}, or configure A/AAAA records matching the target's public addresses, then validate again.` :
        "DNS lookup failed; do not treat an unavailable resolver as a record mismatch. Retry diagnostics." };
  }

  /** Read-only, tenant-scoped TLS diagnostics from worker reconciliation audit.
   * DNS verification and route publication are independent from TLS readiness.
   * Never return raw observer/ACME errors: they may contain internal addresses.
   */
  async getCertificateDiagnostics(tenantId: string, domainId: string) {
    const domain = await this.findDomainOrThrow(tenantId, domainId);
    const lastObservation = await this.prisma.auditLogEntry.findFirst({
      where: {
        tenantId,
        resourceType: "Domain",
        resourceId: domainId,
        action: "domain.certificate.renew",
      },
      orderBy: { timestamp: "desc" },
      select: {
        timestamp: true,
        result: true,
        errorCode: true,
      },
    });
    const tlsRequired = domain.httpEndpoint
      ? protocolModeRequiresTls(domain.httpEndpoint.protocolMode)
      : false;
    const publishable = isDomainPublishable(domain, tenantId);
    const observationFailure = lastObservation?.result === "Failed";
    const code = observationFailure ? lastObservation.errorCode : null;
    const cause = code === "CertificateObservationFailed"
      ? "Managed ingress TLS inspection failed. This can be transient; retry after checking Traefik reachability and ACME logs."
      : code === "CertificateInvalid"
        ? "The managed ingress presented a certificate that is expired or does not cover this hostname."
        : tlsRequired && !lastObservation
          ? "No managed ingress TLS observation has completed yet."
          : null;
    return {
      dnsStatus: domain.dnsStatus,
      tlsRequired,
      certificateStatus: tlsRequired ? domain.certificateStatus : "NotRequired",
      certificateIssuer: tlsRequired ? domain.certificateIssuer : null,
      certificateExpiresAt: tlsRequired ? domain.certificateExpiresAt : null,
      lastCheckedAt: lastObservation?.timestamp ?? null,
      observationSource: "ManagedSwarmIngress",
      observationStatus: !lastObservation ? "NotChecked" :
        observationFailure ? "Failed" : "Succeeded",
      errorCode: code,
      cause,
      transient: code === "CertificateObservationFailed",
      canReconcile: tlsRequired && publishable,
      // Publication is not implied by TLS or DNS. Issue #394 owns the
      // detailed route/ownership diagnostics.
      ingressPublication: "NotVerified",
      deploymentBlocked: tlsRequired && domain.certificateStatus === CertificateStatus.Error,
      deploymentBlockReason: tlsRequired && domain.certificateStatus === CertificateStatus.Error
        ? "Managed ingress TLS state is Error; run certificate diagnostics before deploying."
        : null,
    };
  }

  async getCapabilities() {
    return this.managedDns
      ? this.managedDns.getTenantCapabilities()
      : {
          managedDomains: {
            enabled: false,
            provider: "Cloudflare",
            baseDomain: this.managedBaseDomain(),
          },
        };
  }

  async listCustomRootDomains(tenantId: string) {
    const roots = await this.prisma.customRootDomain.findMany({
      where: { tenantId },
      orderBy: { rootDomain: "asc" },
      include: { domains: true },
    });

    return roots.map(mapCustomRootDomain);
  }

  async getCustomRootDomain(tenantId: string, customRootDomainId: string) {
    const root = await this.findCustomRootDomainOrThrow(
      tenantId,
      customRootDomainId,
    );

    return mapCustomRootDomain(root);
  }

  async createCustomRootDomain(
    tenantId: string,
    dto: CreateCustomRootDomainDto,
    actor: AuthenticatedUser,
  ) {
    const rootDomain = dto.rootDomain.toLowerCase();

    try {
      const root = await this.prisma.customRootDomain.create({
        data: {
          tenantId,
          rootDomain,
          verificationToken: this.verificationToken(),
          createdBy: actor.id,
          updatedBy: actor.id,
        },
        include: { domains: true },
      });

      return mapCustomRootDomain(root);
    } catch (error) {
      this.handleKnownConflict(error, "Custom root domain already exists");
      throw error;
    }
  }

  async createCloudflareCustomRootDomain(
    tenantId: string,
    dto: { zoneId: string; rootDomain: string },
    actor: AuthenticatedUser,
  ) {
    const cloudflare = this.requireTenantCloudflare();
    const rootDomain = dto.rootDomain.toLowerCase();
    const verificationToken = this.verificationToken();
    let root;
    try {
      root = await this.prisma.customRootDomain.create({
        data: {
          tenantId,
          rootDomain,
          verificationMethod: "CLOUDFLARE_OAUTH",
          verificationToken,
          createdBy: actor.id,
          updatedBy: actor.id,
        },
        include: { domains: true },
      });
    } catch (error) {
      this.handleKnownConflict(error, "Custom root domain already exists");
      throw error;
    }

    try {
      await cloudflare.ensureVerificationTxt({
        tenantId,
        userId: actor.id,
        zoneId: dto.zoneId,
        rootDomain,
        verificationToken,
      });
      const verified = await this.prisma.customRootDomain.update({
        where: { id: root.id },
        data: {
          verificationStatus: CustomRootDomainVerificationStatus.Verified,
          verifiedAt: new Date(),
          updatedBy: actor.id,
        },
        include: { domains: true },
      });
      return mapCustomRootDomain(verified);
    } catch (error) {
      await this.prisma.customRootDomain.update({
        where: { id: root.id },
        data: {
          verificationStatus: CustomRootDomainVerificationStatus.Failed,
          updatedBy: actor.id,
        },
      });
      throw error;
    }
  }

  async updateCustomRootDomain(
    tenantId: string,
    customRootDomainId: string,
    dto: UpdateCustomRootDomainDto,
    actor: AuthenticatedUser,
  ) {
    await this.findCustomRootDomainOrThrow(tenantId, customRootDomainId);

    const verificationStatus = dto.verificationStatus;
    const root = await this.prisma.customRootDomain.update({
      where: { id: customRootDomainId },
      data: {
        verificationStatus,
        verifiedAt:
          verificationStatus === CustomRootDomainVerificationStatus.Verified
            ? new Date()
            : verificationStatus === undefined
              ? undefined
              : null,
        updatedBy: actor.id,
      },
      include: { domains: true },
    });

    return mapCustomRootDomain(root);
  }

  async validateCustomRootDomain(
    tenantId: string,
    customRootDomainId: string,
    actor: AuthenticatedUser,
  ) {
    const existing = await this.findCustomRootDomainOrThrow(
      tenantId,
      customRootDomainId,
    );

    let verified = false;
    try {
      const txtRecords = await resolveTxt(existing.rootDomain);
      verified = txtRecords
        .map((parts) => parts.join(""))
        .some((value) => value.trim() === existing.verificationToken);
    } catch {
      verified = false;
    }

    const root = await this.prisma.customRootDomain.update({
      where: { id: customRootDomainId },
      data: {
        verificationStatus: verified
          ? CustomRootDomainVerificationStatus.Verified
          : CustomRootDomainVerificationStatus.Failed,
        verifiedAt: verified ? new Date() : null,
        updatedBy: actor.id,
      },
      include: { domains: true },
    });

    return mapCustomRootDomain(root);
  }

  async deleteCustomRootDomain(tenantId: string, customRootDomainId: string) {
    const root = await this.findCustomRootDomainOrThrow(
      tenantId,
      customRootDomainId,
    );

    if (root.domains.length > 0) {
      throw new ConflictException("CustomRootDomainInUse");
    }

    await this.prisma.customRootDomain.delete({
      where: { id: customRootDomainId },
    });

    return { deleted: true };
  }

  async createDomain(
    tenantId: string,
    dto: CreateDomainDto,
    actor: AuthenticatedUser,
  ) {
    const hostname = await this.resolveHostname(tenantId, dto);
    const endpointContext = dto.httpEndpointId
      ? await this.findEndpointContextOrThrow(tenantId, dto.httpEndpointId)
      : undefined;
    const tlsState = this.domainTlsState(endpointContext?.protocolMode, true);
    const customRoot =
      dto.type === DomainType.Custom && dto.customRootDomainId
        ? await this.findCustomRootDomainOrThrow(tenantId, dto.customRootDomainId)
        : undefined;
    const managedProvision =
      dto.type === DomainType.Managed
        ? await this.requireManagedDns().provisionManagedDomain(hostname)
        : undefined;
    const customProvision =
      customRoot?.verificationMethod === "CLOUDFLARE_OAUTH"
        ? await this.requireTenantCloudflare().ensureManagedCustomDomain({
            tenantId,
            userId: customRoot.createdBy,
            hostname,
          })
        : undefined;
    const manualCustomDnsValid =
      dto.type === DomainType.Custom && !customProvision
        ? await this.customDomainHasDns(hostname)
        : undefined;

    try {
      const domain = await this.prisma.$transaction(async (tx) => {
        const created = await tx.domain.create({
          data: {
            tenantId,
            type: dto.type,
            prefix: dto.type === DomainType.Managed ? dto.prefix : null,
            customRootDomainId:
              dto.type === DomainType.Custom ? dto.customRootDomainId : null,
            subdomain:
              dto.type === DomainType.Managed ? dto.prefix : dto.subdomain,
            hostname,
            dnsStatus:
              dto.type === DomainType.Managed || customProvision
                ? DnsStatus.Valid
                : manualCustomDnsValid
                  ? DnsStatus.Valid
                  : DnsStatus.Invalid,
            ...tlsState,
            httpEndpointId: dto.httpEndpointId,
            createdBy: actor.id,
            updatedBy: actor.id,
          },
          include: this.domainIncludes(),
        });

        if (endpointContext) {
          await this.markAppGroupDraftChanged(
            tx,
            endpointContext.appGroupId,
            actor.id,
          );
        }

        return created;
      });

      return mapDomain(domain);
    } catch (error) {
      if (managedProvision?.created) {
        await this.requireManagedDns()
          .deleteManagedDomain(hostname)
          .catch(() => undefined);
      }
      if (customProvision?.created && customRoot) {
        await this.requireTenantCloudflare()
          .deleteManagedCustomDomain({
            tenantId,
            userId: customRoot.createdBy,
            hostname,
          })
          .catch(() => undefined);
      }
      this.handleKnownConflict(error, "Domain already exists");
      throw error;
    }
  }

  async updateDomain(
    tenantId: string,
    domainId: string,
    dto: UpdateDomainDto,
    actor: AuthenticatedUser,
  ) {
    const existing = await this.findDomainOrThrow(tenantId, domainId);
    // This narrowly repairs legacy custom domains lacking an ownership link.
    // It never transfers an already linked domain or changes hostname, DNS, TLS
    // certificates or the existing endpoint association.
    let verifiedRoot: Awaited<ReturnType<typeof this.findCustomRootDomainOrThrow>> | undefined;
    if (dto.customRootDomainId !== undefined) {
      if (typeof dto.customRootDomainId !== "string" ||
          existing.type !== DomainType.Custom || existing.customRootDomainId != null) {
        throw new ConflictException("LegacyCustomRootLinkOnly");
      }
      const root = await this.findCustomRootDomainOrThrow(tenantId, dto.customRootDomainId);
      if (root.verificationStatus !== CustomRootDomainVerificationStatus.Verified) {
        throw new ConflictException("CustomRootDomainNotVerified");
      }
      const hostname = existing.hostname.toLowerCase().replace(/\.$/, "");
      const suffix = root.rootDomain.toLowerCase().replace(/\.$/, "");
      if (!hostname.endsWith(`.${suffix}`) || hostname.length <= suffix.length + 1) {
        throw new ConflictException("HostnameOutsideVerifiedRoot");
      }
      verifiedRoot = root;
    }
    const effectiveRoot = verifiedRoot ?? existing.customRootDomain;
    if (
      existing.type === DomainType.Custom &&
      dto.httpEndpointId !== null &&
      (effectiveRoot?.verificationStatus !== CustomRootDomainVerificationStatus.Verified ||
        effectiveRoot.tenantId !== tenantId)
    ) {
      throw new ConflictException("CustomRootDomainNotVerified");
    }
    if (
      existing.type === DomainType.Custom &&
      existing.customRootDomain?.verificationMethod === "CLOUDFLARE_OAUTH"
    ) {
      await this.requireTenantCloudflare().ensureManagedCustomDomain({
        tenantId,
        userId: existing.customRootDomain.createdBy,
        hostname: existing.hostname,
      });
    }
    const nextEndpointContext =
      dto.httpEndpointId === undefined || dto.httpEndpointId === null
        ? undefined
        : await this.findEndpointContextOrThrow(tenantId, dto.httpEndpointId);
    const currentEndpointContext = existing.httpEndpointId
      ? await this.findEndpointContextOrThrow(tenantId, existing.httpEndpointId)
      : undefined;
    const effectiveEndpointContext =
      dto.httpEndpointId === undefined
        ? currentEndpointContext
        : nextEndpointContext;
    // Root ownership repair alone must not modify existing certificate or TLS
    // metadata, including when this legacy domain is unassigned or HTTP-only.
    const rootOnlyRepair = dto.customRootDomainId !== undefined && dto.httpEndpointId === undefined;
    const tlsState = rootOnlyRepair ? {} : this.domainTlsState(effectiveEndpointContext?.protocolMode);

    const domain = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.domain.update({
        where: { id: domainId },
        data: {
          httpEndpointId:
            dto.httpEndpointId === undefined ? undefined : dto.httpEndpointId,
          customRootDomainId: verifiedRoot?.id,
          ...tlsState,
          updatedBy: actor.id,
        },
        include: this.domainIncludes(),
      });

      const changedAppGroupIds = new Set<string>();
      if (currentEndpointContext) {
        changedAppGroupIds.add(currentEndpointContext.appGroupId);
      }
      if (nextEndpointContext) {
        changedAppGroupIds.add(nextEndpointContext.appGroupId);
      }

      for (const appGroupId of changedAppGroupIds) {
        await this.markAppGroupDraftChanged(tx, appGroupId, actor.id);
      }

      return updated;
    });

    return mapDomain(domain);
  }

  async deleteDomain(
    tenantId: string,
    domainId: string,
    actor: AuthenticatedUser,
  ) {
    const existing = await this.findDomainOrThrow(tenantId, domainId);
    const endpointContext = existing.httpEndpointId
      ? await this.findEndpointContextOrThrow(tenantId, existing.httpEndpointId)
      : undefined;
    const managedDnsRemoved =
      existing.type === DomainType.Managed
        ? await this.requireManagedDns().deleteManagedDomain(existing.hostname)
        : undefined;
    const customDnsRemoved =
      existing.type === DomainType.Custom &&
      existing.customRootDomain?.verificationMethod === "CLOUDFLARE_OAUTH"
        ? await this.requireTenantCloudflare().deleteManagedCustomDomain({
            tenantId,
            userId: existing.customRootDomain.createdBy,
            hostname: existing.hostname,
          })
        : undefined;

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.domain.delete({
          where: { id: domainId },
        });

        if (endpointContext) {
          await this.markAppGroupDraftChanged(tx, endpointContext.appGroupId, actor.id);
        }
      });
    } catch (error) {
      if (existing.type === DomainType.Managed && managedDnsRemoved?.deleted) {
        await this.requireManagedDns()
          .provisionManagedDomain(existing.hostname)
          .catch(() => undefined);
      }
      if (
        existing.type === DomainType.Custom &&
        customDnsRemoved?.deleted &&
        existing.customRootDomain?.verificationMethod === "CLOUDFLARE_OAUTH"
      ) {
        await this.requireTenantCloudflare()
          .ensureManagedCustomDomain({
            tenantId,
            userId: existing.customRootDomain.createdBy,
            hostname: existing.hostname,
          })
          .catch(() => undefined);
      }
      throw error;
    }

    return { deleted: true };
  }

  async validateDomain(tenantId: string, domainId: string, actor: AuthenticatedUser) {
    const existing = await this.findDomainOrThrow(tenantId, domainId);
    let valid: boolean;
    if (existing.type === DomainType.Managed) {
      valid = await this.requireManagedDns().managedDomainExists(existing.hostname);
    } else if (
      !existing.customRootDomain ||
      existing.customRootDomain.tenantId !== tenantId ||
      !isDomainPublishable({ ...existing, dnsStatus: DnsStatus.Valid }, tenantId)
    ) {
      // Legacy custom domains without ownership proof remain unpublishable.
      valid = false;
    } else if (
      existing.customRootDomain.verificationMethod === "CLOUDFLARE_OAUTH"
    ) {
      valid = await this.requireTenantCloudflare().managedCustomDomainExists({
        tenantId,
        userId: existing.customRootDomain.createdBy,
        hostname: existing.hostname,
      });
    } else {
      valid = await this.customDomainHasDns(existing.hostname);
    }

    const domain = await this.prisma.domain.update({
      where: { id: domainId },
      data: {
        dnsStatus: valid ? DnsStatus.Valid : DnsStatus.Invalid,
        updatedBy: actor.id,
      },
      include: this.domainIncludes(),
    });

    return mapDomain(domain);
  }

  private async resolveHostname(tenantId: string, dto: CreateDomainDto) {
    if (dto.type === DomainType.Managed) {
      if (!dto.prefix) {
        throw new BadRequestException("Managed domain requires prefix");
      }

      return `${dto.prefix}.${this.managedBaseDomain()}`;
    }

    if (dto.customRootDomainId || dto.subdomain) {
      if (!dto.customRootDomainId || !dto.subdomain) {
        throw new BadRequestException(
          "Custom root domain requires customRootDomainId and subdomain",
        );
      }

      const root = await this.findCustomRootDomainOrThrow(
        tenantId,
        dto.customRootDomainId,
      );

      if (
        root.verificationStatus !==
        CustomRootDomainVerificationStatus.Verified
      ) {
        throw new ConflictException("CustomRootDomainNotVerified");
      }

      return `${dto.subdomain}.${root.rootDomain}`;
    }

    // A matching DNS A/CNAME record only proves routing, not ownership.
    // All custom hostnames must be derived from a verified tenant root.
    throw new BadRequestException(
      "Custom domain requires a verified customRootDomainId and subdomain",
    );
  }

  private managedBaseDomain() {
    return this.config.get<string>(
      "MANAGED_DOMAIN_BASE",
      "apps.resource-portal.local",
    );
  }

  private async customDomainHasDns(hostname: string) {
    const target = (
      this.managedDns?.getDomainTargetHostname() ??
      this.config.get<string>(
        "RESOURCEPORTAL_PUBLIC_HOSTNAME",
        this.managedBaseDomain(),
      )
    )
      .trim()
      .toLowerCase()
      .replace(/\.$/, "");
    const normalized = hostname.toLowerCase();
    if (normalized === target) return true;

    try {
      const cnames = await resolveCname(hostname);
      if (
        Array.isArray(cnames) &&
        cnames.some(
          (value) => value.toLowerCase().replace(/\.$/, "") === target,
        )
      ) {
        return true;
      }
    } catch {
      // A/AAAA records are checked below for providers that flatten CNAMEs.
    }

    const safeAddresses = async (
      resolver: (value: string) => Promise<string[]>,
      value: string,
    ) => {
      try {
        const addresses = await resolver(value);
        return Array.isArray(addresses) ? addresses : [];
      } catch {
        return [];
      }
    };
    const [hostnameV4, targetV4, hostnameV6, targetV6] = await Promise.all([
      safeAddresses((value) => resolve4(value), hostname),
      safeAddresses((value) => resolve4(value), target),
      safeAddresses((value) => resolve6(value), hostname),
      safeAddresses((value) => resolve6(value), target),
    ]);
    const targetAddresses = new Set([...targetV4, ...targetV6]);
    return [...hostnameV4, ...hostnameV6].some((address) =>
      targetAddresses.has(address),
    );
  }

  private domainTlsState(protocolMode?: string, initialize = false) {
    const tlsEnabled = protocolMode
      ? protocolModeRequiresTls(protocolMode)
      : false;

    if (tlsEnabled && !initialize) {
      return { tlsEnabled };
    }

    return {
      tlsEnabled,
      certificateStatus: CertificateStatus.Pending,
      certificateIssuer: null,
      certificateExpiresAt: null,
    };
  }

  private async findDomainOrThrow(tenantId: string, domainId: string) {
    const domain = await this.prisma.domain.findFirst({
      where: { id: domainId, tenantId },
      include: this.domainIncludes(),
    });

    if (!domain) {
      throw new NotFoundException("Domain not found");
    }

    return domain;
  }

  private async findCustomRootDomainOrThrow(
    tenantId: string,
    customRootDomainId: string,
  ) {
    const root = await this.prisma.customRootDomain.findFirst({
      where: { id: customRootDomainId, tenantId },
      include: { domains: true },
    });

    if (!root) {
      throw new NotFoundException("Custom root domain not found");
    }

    return root;
  }

  private async findEndpointContextOrThrow(
    tenantId: string,
    httpEndpointId: string,
  ) {
    const endpoint = await this.prisma.httpEndpoint.findFirst({
      where: {
        id: httpEndpointId,
        singleApp: {
          appGroup: {
            tenantId,
          },
        },
      },
      select: {
        id: true,
        protocolMode: true,
        singleApp: {
          select: {
            appGroupId: true,
          },
        },
      },
    });

    if (!endpoint) {
      throw new NotFoundException("HTTP endpoint not found");
    }

    return {
      httpEndpointId: endpoint.id,
      appGroupId: endpoint.singleApp.appGroupId,
      protocolMode: endpoint.protocolMode,
    };
  }

  private markAppGroupDraftChanged(
    tx: Prisma.TransactionClient,
    appGroupId: string,
    actorId: string,
  ) {
    return tx.appGroup.update({
      where: { id: appGroupId },
      data: {
        hasPendingChanges: true,
        runtimeDraftRevision: {
          increment: 1,
        },
        updatedBy: actorId,
      },
    });
  }

  private domainIncludes() {
    return {
      customRootDomain: true,
      httpEndpoint: {
        include: {
          singleApp: {
            select: {
              id: true,
              name: true,
              appGroupId: true,
              runtimeState: true,
              pendingDeletion: true,
              appGroup: { select: { tenantId: true, runtimeState: true, currentDeploymentVersion: true, hasPendingChanges: true } },
            },
          },
        },
      },
    } satisfies Prisma.DomainInclude;
  }

  private requireTenantCloudflare() {
    if (!this.tenantCloudflare) {
      throw new ConflictException("Cloudflare domain authorization is unavailable");
    }
    return this.tenantCloudflare;
  }

  private requireManagedDns() {
    if (!this.managedDns) {
      throw new ConflictException("Managed ResourcePortal domains are unavailable");
    }
    return this.managedDns;
  }

  private handleKnownConflict(error: unknown, message: string) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new ConflictException(message);
    }
  }

  private verificationToken() {
    return `rp-domain-verification=${crypto.randomBytes(24).toString("hex")}`;
  }
}
