import { CustomRootDomain, Domain } from "@prisma/client";

type DomainWithEndpoint = Domain & {
  httpEndpoint?: {
    id: string;
    name: string;
    containerPort: number;
    singleApp: {
      id: string;
      name: string;
      appGroupId: string;
    };
  } | null;
};

export function mapDomain(domain: DomainWithEndpoint) {
  return {
    id: domain.id,
    tenantId: domain.tenantId,
    type: domain.type,
    prefix: domain.prefix,
    customRootDomainId: domain.customRootDomainId,
    subdomain: domain.subdomain,
    hostname: domain.hostname,
    dnsStatus: domain.dnsStatus,
    tlsEnabled: domain.tlsEnabled,
    certificateStatus: domain.certificateStatus,
    certificateIssuer: domain.certificateIssuer,
    certificateExpiresAt: domain.certificateExpiresAt,
    httpEndpointId: domain.httpEndpointId,
    httpEndpoint: domain.httpEndpoint
      ? {
          id: domain.httpEndpoint.id,
          name: domain.httpEndpoint.name,
          containerPort: domain.httpEndpoint.containerPort,
          singleAppId: domain.httpEndpoint.singleApp.id,
          singleAppName: domain.httpEndpoint.singleApp.name,
          appGroupId: domain.httpEndpoint.singleApp.appGroupId,
        }
      : null,
    createdBy: domain.createdBy,
    updatedBy: domain.updatedBy,
    createdAt: domain.createdAt,
    updatedAt: domain.updatedAt,
  };
}

export function mapCustomRootDomain(
  customRootDomain: CustomRootDomain & { domains?: Domain[] },
) {
  return {
    id: customRootDomain.id,
    tenantId: customRootDomain.tenantId,
    rootDomain: customRootDomain.rootDomain,
    verificationStatus: customRootDomain.verificationStatus,
    verificationMethod: customRootDomain.verificationMethod,
    verificationToken: customRootDomain.verificationToken,
    verificationCreatedAt: customRootDomain.verificationCreatedAt,
    verifiedAt: customRootDomain.verifiedAt,
    domainCount: customRootDomain.domains?.length ?? 0,
    createdBy: customRootDomain.createdBy,
    updatedBy: customRootDomain.updatedBy,
    createdAt: customRootDomain.createdAt,
    updatedAt: customRootDomain.updatedAt,
  };
}
