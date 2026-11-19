import { Card, Button } from "../../components/design-system";
import { items, text, useApi } from "../../hooks/use-api";
import { tenantHref } from "../../router/router";

type Domain = Record<string, unknown>;

const blockerCopy: Record<string, string> = {
  VerifiedRootLinkMissing: "DomainOwnershipNotVerified: link this custom hostname to a tenant-owned verified root",
  RootNotVerified: "DomainOwnershipNotVerified: verify custom-root ownership",
  RootTenantMismatch: "DomainOwnershipNotVerified: root ownership does not match this tenant",
  HostnameOutsideVerifiedRoot: "DomainOwnershipNotVerified: hostname is outside its verified root",
  DnsNotValid: "Validate DNS and correct the expected record",
  NoHttpEndpoint: "Assign a compatible HTTP endpoint",
  MissingApplicationEndpoint: "Repair the missing application endpoint",
  AppGroupTenantUnknown: "Verify App Group ownership and runtime status",
  AppGroupStopped: "Start the App Group before expecting published traffic",
  ApplicationStopped: "Start the application before expecting published traffic",
  ApplicationPendingDeletion: "The application is pending deletion",
  TlsCertificateError: "Resolve the HTTPS certificate error",
};

export function domainDeploymentFindings(value: unknown, appGroupId: string) {
  return items<Domain>(value)
    .filter((domain) => {
      const endpoint = domain.httpEndpoint;
      if (!endpoint || typeof endpoint !== "object") return false;
      return (endpoint as Record<string, unknown>).appGroupId === appGroupId;
    })
    .map((domain) => {
      const ingress = domain.ingress && typeof domain.ingress === "object"
        ? domain.ingress as Record<string, unknown> : {};
      const preflight = ingress.preflight && typeof ingress.preflight === "object"
        ? ingress.preflight as Record<string, unknown> : {};
      const publication = domain.publication && typeof domain.publication === "object"
        ? domain.publication as Record<string, unknown> : {};
      const blockers = Array.isArray(preflight.blockers)
        ? preflight.blockers.filter((code): code is string => typeof code === "string")
        : [];
      if (publication.eligible === false && typeof publication.reason === "string" && !blockers.includes(publication.reason)) {
        blockers.unshift(publication.reason);
      }
      return {
        id: text(domain.id, ""),
        hostname: text(domain.hostname, "Unknown hostname"),
        blockers,
        deploymentRequired: preflight.deploymentRequired === true,
        unknown: !Array.isArray(preflight.blockers) || typeof publication.eligible !== "boolean",
      };
    });
}

/** Read-only tenant-scoped evidence. The server remains the authoritative deploy gate. */
export function AppGroupDomainPreflight({ tenantId, appGroupId }: { tenantId: string; appGroupId: string }) {
  const query = useApi<unknown>(`/api/tenants/${encodeURIComponent(tenantId)}/domains`);
  const findings = domainDeploymentFindings(query.data, appGroupId);
  const blocked = findings.filter((domain) => domain.blockers.length > 0);
  const unknown = findings.filter((domain) => domain.unknown);
  return <Card className="p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 className="font-semibold text-[#172033]">Domain deployment preflight</h3>
        <p className="mt-1 text-sm text-[#5B6678]">
          Read-only DNS, ownership and ingress blockers for domains assigned to this App Group. This does not verify a live Traefik router or replace server-side deployment validation.
        </p>
      </div>
      <Button size="sm" onClick={() => void query.reload()} disabled={query.loading}>Refresh domains</Button>
    </div>
    {query.loading ? <p className="mt-3 text-sm" role="status">Checking tenant domains…</p> : null}
    {query.error ? <p className="mt-3 text-sm text-red-700" role="alert">Domain preflight could not be loaded. Do not infer that deployment is safe; retry or check Domains.</p> : null}
    {!query.loading && !query.error && query.data ? <>
      {findings.length === 0 ? <p className="mt-3 text-sm">No domains with a confirmed endpoint assignment to this App Group were returned. Unassigned domains and domains without endpoint ownership cannot be assessed here.</p> : null}
      {findings.length > 0 && blocked.length === 0 && unknown.length === 0
        ? <p className="mt-3 text-sm">No blockers reported for {findings.length} assigned domain(s). Actual routing is not verified; deployment validation remains authoritative.</p>
        : null}
      {findings.map((domain) => <div key={domain.id} className="mt-3 rounded-md border border-[#D7E0EC] p-3">
        <a href={tenantHref(tenantId, "domains", domain.id)} className="text-sm font-semibold text-[#0F56A7] hover:underline">{domain.hostname}</a>
        {domain.unknown ? <p className="mt-1 text-sm text-[#8A5800]">Publication/preflight evidence is incomplete. Review this domain before deploying.</p> : null}
        {domain.blockers.length ? <ul className="mt-2 list-disc pl-5 text-sm text-[#8A5800]">
          {domain.blockers.map((code) => <li key={code}>{blockerCopy[code] ?? "Resolve domain publication blocker"} ({code})</li>)}
        </ul> : !domain.unknown ? <p className="mt-1 text-sm">No domain publication blockers reported.</p> : null}
        {domain.deploymentRequired ? <p className="mt-1 text-xs text-[#5B6678]">App Group changes require deployment before routing can be assessed.</p> : null}
      </div>)}
    </> : null}
  </Card>;
}
