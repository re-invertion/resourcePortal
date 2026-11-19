import { CustomRootDomain, Domain, CustomRootDomainVerificationStatus, CertificateStatus } from "@prisma/client";
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

  // This is a fail-closed deploy/reconciliation preflight, not an assertion
  // that Traefik has actually installed a route. Mirrors the publication and
  // stopped-service filters but keeps TLS and stale deployments distinct.
  const preflightBlockers: string[] = [];
  if (!publication.eligible) preflightBlockers.push(publication.reason ?? "DomainNotPublishable");
  if (!app) preflightBlockers.push("MissingApplicationEndpoint");
  if (!group || group.tenantId !== domain.tenantId) preflightBlockers.push("AppGroupTenantUnknown");
  else if (group.runtimeState === "Stopped") preflightBlockers.push("AppGroupStopped");
  if (app?.runtimeState === "Stopped") preflightBlockers.push("ApplicationStopped");
  if (app?.pendingDeletion) preflightBlockers.push("ApplicationPendingDeletion");
  if (tlsEnabled && domain.certificateStatus === CertificateStatus.Error) {
    preflightBlockers.push("TlsCertificateError");
  }
  const deploymentRequired = !group || group.currentDeploymentVersion == null || group.hasPendingChanges;
  const preflightReady = preflightBlockers.length === 0 && !deploymentRequired;

  return {
    publication,
    ingress: {
      intentStatus: ingressIntent,
      observedRouter: "NotChecked" as const,
      currentDeploymentVersion: group?.currentDeploymentVersion ?? null,
      preflight: {
        readyForRuntimeInspection: preflightReady,
        deploymentRequired,
        blockers: preflightBlockers,
        // A green preflight is only readiness to *inspect* runtime state,
        // not evidence that a live router or backend is reachable.
        liveRouterVerified: false as const,
      },
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
