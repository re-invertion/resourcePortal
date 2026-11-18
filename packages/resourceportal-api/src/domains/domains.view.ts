import { CustomRootDomain, Domain, CustomRootDomainVerificationStatus } from "@prisma/client";
import { domainPublicationDiagnostics } from "./domain-publication";
import { protocolModeRequiresTls } from "../internal/traefik-routing";

type DomainWithEndpoint = Domain & {
  customRootDomain?: { tenantId: string; rootDomain: string; verificationStatus: CustomRootDomainVerificationStatus } | null;
  httpEndpoint?: {
    id: string;
    name: string;
    containerPort: number;
    protocolMode: string;
    singleApp: {
      id: string;
      name: string;
      appGroupId: string;
      runtimeState?: string;
      pendingDeletion?: boolean;
      appGroup?: {
        tenantId: string;
        runtimeState: string;
        currentDeploymentVersion: number | null;
        hasPendingChanges: boolean;
      };
    };
  } | null;
};

export function mapDomain(domain: DomainWithEndpoint) {
  const tlsEnabled = domain.httpEndpoint
    ? protocolModeRequiresTls(domain.httpEndpoint.protocolMode)
    : false;

  const publication = domainPublicationDiagnostics(domain, domain.tenantId);
  const app = domain.httpEndpoint?.singleApp;
  const group = app?.appGroup;
  // Mirrors the ingress reconciler's stopped-app/stopped-group filter, but
  // never claims that an actual Traefik route has been observed.
  const ingressIntent = !publication.eligible ? "NotEligible" :
    !app ? "NoEndpoint" :
    !group || group.tenantId !== domain.tenantId ? "Unknown" :
    group.runtimeState === "Stopped" ? "AppGroupStopped" :
    app.runtimeState === "Stopped" ? "ApplicationStopped" :
    app.pendingDeletion === true ? "ApplicationPendingDeletion" :
    group.currentDeploymentVersion == null ? "NeverDeployed" :
    group.hasPendingChanges ? "PendingDeployment" : "RouteEligibleNotObserved";

  return {
    publication,
    ingress: {
      intentStatus: ingressIntent,
      observedRouter: "NotChecked" as const,
      currentDeploymentVersion: group?.currentDeploymentVersion ?? null,
    },
    id: domain.id,
    tenantId: domain.tenantId,
    type: domain.type,
    prefix: domain.prefix,
    customRootDomainId: domain.customRootDomainId,
    subdomain: domain.subdomain,
    hostname: domain.hostname,
    dnsStatus: domain.dnsStatus,
    tlsEnabled,
    certificateStatus: tlsEnabled ? domain.certificateStatus : "Pending",
    certificateIssuer: tlsEnabled ? domain.certificateIssuer : null,
    certificateExpiresAt: tlsEnabled ? domain.certificateExpiresAt : null,
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
