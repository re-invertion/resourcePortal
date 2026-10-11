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
