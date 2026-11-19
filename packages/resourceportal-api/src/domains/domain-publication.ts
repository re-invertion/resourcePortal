import { DomainType, DnsStatus, CustomRootDomainVerificationStatus } from "@prisma/client";

/** Only DNS entries whose authority is verified for this tenant may reach Traefik. */
export function isDomainPublishable(
  domain: {
    tenantId?: string;
    type?: DomainType;
    hostname?: string;
    dnsStatus?: DnsStatus;
    customRootDomain?: {
      tenantId: string;
      rootDomain: string;
      verificationStatus: CustomRootDomainVerificationStatus;
    } | null;
  },
  tenantId: string,
): boolean {
  if (domain.tenantId !== tenantId || domain.dnsStatus !== DnsStatus.Valid) return false;
  if (domain.type === DomainType.Managed) return true;
  if (domain.type !== DomainType.Custom) return false;
  const root = domain.customRootDomain;
  if (!root || root.tenantId !== tenantId ||
      root.verificationStatus !== CustomRootDomainVerificationStatus.Verified) return false;
  const hostname = domain.hostname?.toLowerCase();
  const suffix = root.rootDomain.toLowerCase();
  return Boolean(hostname && hostname.endsWith(`.${suffix}`) && hostname.length > suffix.length + 1);
}

/**
 * Explain publication eligibility using the same gate as the ingress reconciler.
 * Eligibility does not prove a live Traefik router exists.
 */
export function domainPublicationDiagnostics(
  domain: Parameters<typeof isDomainPublishable>[0] & { httpEndpointId?: string | null },
  tenantId: string,
): { eligible: boolean; reason: string | null } {
  if (isDomainPublishable(domain, tenantId)) {
    return domain.httpEndpointId
      ? { eligible: true, reason: null }
      : { eligible: false, reason: "NoHttpEndpoint" };
  }
  if (domain.tenantId !== tenantId) return { eligible: false, reason: "TenantMismatch" };
  if (domain.dnsStatus !== DnsStatus.Valid) return { eligible: false, reason: "DnsNotValid" };
  if (domain.type !== DomainType.Custom) return { eligible: false, reason: "UnsupportedDomainType" };
  const root = domain.customRootDomain;
  if (!root) return { eligible: false, reason: "VerifiedRootLinkMissing" };
  if (root.tenantId !== tenantId) return { eligible: false, reason: "RootTenantMismatch" };
  if (root.verificationStatus !== CustomRootDomainVerificationStatus.Verified) {
    return { eligible: false, reason: "RootNotVerified" };
  }
  const hostname = domain.hostname?.toLowerCase();
  const suffix = root.rootDomain.toLowerCase();
  if (!hostname || !hostname.endsWith(`.${suffix}`) || hostname.length <= suffix.length + 1) {
    return { eligible: false, reason: "HostnameOutsideVerifiedRoot" };
  }
  return { eligible: false, reason: "NotPublishable" };
}
