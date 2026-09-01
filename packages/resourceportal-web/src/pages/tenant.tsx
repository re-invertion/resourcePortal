import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../api/client";
import { ConfirmButton, JsonPayloadForm, OneTimeCredential } from "../components/forms";
import { ErrorState, ReadOnlyPanel, ResourcePanel } from "../components/resource";
import { buildAuditQueries, formatAuditExport } from "./audit-query";
import { buildQuotaMutation } from "./quota-payload";

const enc = encodeURIComponent;
const itemId = (item: Record<string, unknown>) => enc(String(item.id ?? ""));

function collectPermissions(value: unknown, userId: string): string[] | undefined {
  const list = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).items) ? (value as Record<string, unknown>).items as unknown[] : [];
  const membership = list.find((candidate) => {
    if (!candidate || typeof candidate !== "object") return false;
    const row = candidate as Record<string, unknown>;
    return row.userId === userId || (row.user && typeof row.user === "object" && (row.user as Record<string, unknown>).id === userId);
  }) as Record<string, unknown> | undefined;
  if (!membership) return undefined;
  const direct = membership.effectivePermissions ?? membership.permissions;
  if (Array.isArray(direct)) return direct.filter((entry): entry is string => typeof entry === "string");
  if (Array.isArray(membership.roles)) {
    return [...new Set(membership.roles.flatMap((role) => role && typeof role === "object" && Array.isArray((role as Record<string, unknown>).permissions) ? (role as Record<string, unknown>).permissions as string[] : []))];
  }
  return undefined;
}

function MutationButton({ label, path, method = "POST", confirm }: { label: string; path: string; method?: "POST" | "PATCH"; confirm?: string }) {
  const [error, setError] = useState<unknown>();
  const [working, setWorking] = useState(false);
  const action = async () => {
    setWorking(true); setError(undefined);
    try { await apiRequest(path, { method }); } catch (cause) { setError(cause); } finally { setWorking(false); }
  };
  return <>{confirm ? <ConfirmButton confirm={confirm} onConfirm={action}>{label}</ConfirmButton> : <button type="button" disabled={working} onClick={() => void action()}>{working ? "Working…" : label}</button>}{error ? <ErrorState error={error} /> : null}</>;
}

function PatchSingleton({ title, path }: { title: string; path: string }) {
  const [credential, setCredential] = useState<unknown>();
  const [error, setError] = useState<unknown>();
  return <section><ReadOnlyPanel title={title} path={path} />{error ? <ErrorState error={error} /> : null}<JsonPayloadForm submitLabel="Save" onSubmit={async (body) => { try { const result = await apiRequest(path, { method: "PATCH", body }); setCredential(result); } catch (cause) { setError(cause); } }} />{credential ? <pre>{JSON.stringify(credential, null, 2)}</pre> : null}</section>;
}

export function TenantPage({ tenantId, section, resourceId, userId }: { tenantId: string; section: string; resourceId?: string; userId: string }) {
  const root = `/api/tenants/${enc(tenantId)}`;
  const [permissions, setPermissions] = useState<string[] | undefined>();
  useEffect(() => { apiRequest(`${root}/memberships`).then((value) => setPermissions(collectPermissions(value, userId))).catch(() => setPermissions(undefined)); }, [root, userId]);

  if (section === "overview") return <main><h1>Tenant overview</h1><ReadOnlyPanel title="Tenant overview" path={root} /></main>;
  if (section === "app-groups") return resourceId ? <AppGroupPage tenantId={tenantId} appGroupId={resourceId} permissions={permissions} /> : <main><h1>AppGroups</h1><ResourcePanel title="AppGroups" listPath={`${root}/app-groups`} createPath={`${root}/app-groups`} itemPath={(item) => `${root}/app-groups/${itemId(item)}`} detailHref={(item) => `/tenants/${enc(tenantId)}/app-groups/${itemId(item)}`} createPermission="app_group.create" updatePermission="app_group.update" deletePermission="app_group.delete" permissions={permissions} /></main>;
  if (section === "volumes") return <main><h1>Volumes</h1><ResourcePanel title="Volumes" listPath={`${root}/volumes`} createPath={`${root}/volumes`} actions={[{ label: "Grow / resize", method: "PATCH", path: (item) => `${root}/volumes/${itemId(item)}/resize`, body: true }, { label: "Delete", method: "DELETE", path: (item) => `${root}/volumes/${itemId(item)}`, destructive: true }]} permissions={permissions} /></main>;
  if (section === "registries") return <main><h1>Registries</h1><ResourcePanel title="Registries" listPath={`${root}/registries`} createPath={`${root}/registries`} itemPath={(item) => `${root}/registries/${itemId(item)}`} actions={[{ label: "Validate", method: "POST", path: (item) => `${root}/registries/${itemId(item)}/validate` }]} permissions={permissions} /></main>;
  if (section === "domains") return <DomainPage root={root} />;
  if (section === "administration") return <AdministrationPage root={root} permissions={permissions} />;
  if (section === "credentials") return <CredentialPage root={root} permissions={permissions} />;
  if (section === "billing") return <BillingPage root={root} />;
  if (section === "audit") return <AuditPage root={root} />;
  if (section === "operations") return <OperationsPage tenantId={tenantId} root={root} operationId={resourceId} />;
  return <main><h1>Tenant page not found</h1><p>Unknown section: {section}</p></main>;
}

function AppGroupPage({ tenantId, appGroupId, permissions }: { tenantId: string; appGroupId: string; permissions?: string[] }) {
  const root = `/api/tenants/${enc(tenantId)}/app-groups/${enc(appGroupId)}`;
  return <main>
    <p><a href={`/tenants/${enc(tenantId)}/app-groups`}>← AppGroups</a></p>
    <h1>AppGroup {appGroupId}</h1>
    <ReadOnlyPanel title="AppGroup detail" path={root} />
    <section><h2>Runtime</h2><MutationButton label="Start" path={`${root}/runtime/start`} /><MutationButton label="Stop" path={`${root}/runtime/stop`} /><MutationButton label="Restart" path={`${root}/runtime/restart`} /><MutationButton label="Discard draft changes" path={`${root}/discard-changes`} confirm="Discard all draft changes?" /></section>
    <ReadOnlyPanel title="Stack preview" path={`${root}/stack-preview`} />
    <ResourcePanel title="SingleApps" listPath={`${root}/single-apps`} createPath={`${root}/single-apps`} itemPath={(item) => `${root}/single-apps/${itemId(item)}`} actions={[{ label: "Start", method: "POST", path: (item) => `${root}/single-apps/${itemId(item)}/runtime/start` }, { label: "Stop", method: "POST", path: (item) => `${root}/single-apps/${itemId(item)}/runtime/stop` }, { label: "Restart", method: "POST", path: (item) => `${root}/single-apps/${itemId(item)}/runtime/restart` }]} permissions={permissions} />
    <ResourcePanel title="Variables" listPath={`${root}/variables`} createPath={`${root}/variables`} itemPath={(item) => `${root}/variables/${itemId(item)}`} permissions={permissions} />
    <ResourcePanel title="Configs" listPath={`${root}/configs`} createPath={`${root}/configs`} itemPath={(item) => `${root}/configs/${itemId(item)}`} permissions={permissions} />
    <ResourcePanel title="Secrets" listPath={`${root}/secrets`} createPath={`${root}/secrets`} itemPath={(item) => `${root}/secrets/${itemId(item)}`} help="Secret values are accepted only in mutation payloads; reads render backend metadata only." permissions={permissions} />
    <DeploymentWorkbench root={root} />
    <SingleAppWorkbench root={root} />
  </main>;
}

function DeploymentWorkbench({ root }: { root: string }) {
  const [deploymentId, setDeploymentId] = useState("");
  const [created, setCreated] = useState<unknown>();
  const [error, setError] = useState<unknown>();
  return <section><h2>Deployments</h2>{error ? <ErrorState error={error} /> : null}<JsonPayloadForm submitLabel="Deploy" onSubmit={async (body) => { try { setCreated(await apiRequest(`${root}/deploy`, { method: "POST", body, headers: { "idempotency-key": crypto.randomUUID() } })); } catch (cause) { setError(cause); } }} />{created ? <pre>{JSON.stringify(created, null, 2)}</pre> : null}<ResourcePanel title="Deployment history" listPath={`${root}/deployments`} actions={[{ label: "Rollback", method: "POST", path: (item) => `${root}/deployments/${itemId(item)}/rollback`, body: true }]} /><label>Deployment ID for detail/events <input value={deploymentId} onChange={(event) => setDeploymentId(event.target.value)} /></label>{deploymentId ? <><ReadOnlyPanel title="Deployment detail" path={`${root}/deployments/${enc(deploymentId)}`} /><ReadOnlyPanel title="Deployment events" path={`${root}/deployments/${enc(deploymentId)}/events`} /></> : null}</section>;
}

function SingleAppWorkbench({ root }: { root: string }) {
  const [singleAppId, setSingleAppId] = useState("");
  const appRoot = `${root}/single-apps/${enc(singleAppId)}`;
  const attachmentTypes = ["variable", "config", "secret", "volume"] as const;
  return <section><h2>SingleApp configuration / attachments / HTTP endpoints</h2><label>SingleApp ID <input value={singleAppId} onChange={(event) => setSingleAppId(event.target.value)} /></label>{singleAppId ? <><PatchSingleton title="Runtime / resource configuration" path={`${appRoot}/runtime-config`} /><ResourcePanel title="HTTP endpoints" listPath={`${appRoot}/http-endpoints`} createPath={`${appRoot}/http-endpoints`} itemPath={(item) => `${appRoot}/http-endpoints/${itemId(item)}`} />{attachmentTypes.map((type) => <details key={type}><summary>Attach {type}</summary><JsonPayloadForm submitLabel={`Attach ${type}`} onSubmit={async (body) => { await apiRequest(`${appRoot}/${type}-attachments`, { method: "POST", body }); }} /><p>Detach uses DELETE on the attachment ID returned by the API.</p><JsonPayloadForm submitLabel={`Detach ${type}`} initialValue={{ attachmentId: "" }} onSubmit={async (body) => { const attachmentId = String(body.attachmentId ?? ""); if (!attachmentId) throw new Error("attachmentId is required"); await apiRequest(`${appRoot}/${type}-attachments/${enc(attachmentId)}`, { method: "DELETE" }); }} /></details>)}</> : <p>Choose a SingleApp ID to manage scoped settings.</p>}</section>;
}

function DomainPage({ root }: { root: string }) {
  return <main><h1>Domains and HTTP routing</h1><ResourcePanel title="Domains" listPath={`${root}/domains`} createPath={`${root}/domains`} itemPath={(item) => `${root}/domains/${itemId(item)}`} actions={[{ label: "Validate", method: "POST", path: (item) => `${root}/domains/${itemId(item)}/validate` }]} /><ResourcePanel title="Custom root domains" listPath={`${root}/domains/custom-root-domains`} createPath={`${root}/domains/custom-root-domains`} itemPath={(item) => `${root}/domains/custom-root-domains/${itemId(item)}`} actions={[{ label: "Validate", method: "POST", path: (item) => `${root}/domains/custom-root-domains/${itemId(item)}/validate` }]} /><p>HTTP endpoint assignment is managed inside an AppGroup using the SingleApp workbench.</p></main>;
}

function AdministrationPage({ root, permissions }: { root: string; permissions?: string[] }) {
  return <main><h1>Tenant administration</h1><ResourcePanel title="Memberships" listPath={`${root}/memberships`} createPath={`${root}/memberships`} itemPath={(item) => `${root}/memberships/${itemId(item)}`} permissions={permissions} /><ReadOnlyPanel title="Roles" path={`${root}/roles`} /><ResourcePanel title="Invitations" listPath={`${root}/invitations`} createPath={`${root}/invitations`} actions={[{ label: "Resend", method: "POST", path: (item) => `${root}/invitations/${itemId(item)}/resend` }, { label: "Delete", method: "DELETE", path: (item) => `${root}/invitations/${itemId(item)}`, destructive: true }]} permissions={permissions} /><ResourcePanel title="Groups" listPath={`${root}/groups`} createPath={`${root}/groups`} itemPath={(item) => `${root}/groups/${itemId(item)}`} permissions={permissions} /><PatchSingleton title="Authentication policy" path={`${root}/auth-policy`} /><ResourcePanel title="Identity providers" listPath={`${root}/identity-providers`} createPath={`${root}/identity-providers`} itemPath={(item) => `${root}/identity-providers/${itemId(item)}`} permissions={permissions} /></main>;
}

function CredentialPage({ root, permissions }: { root: string; permissions?: string[] }) {
  const credentialActions = (resource: string) => [{ label: "Rotate credentials", method: "POST" as const, path: (item: Record<string, unknown>) => `${root}/${resource}/${itemId(item)}/rotate-credentials`, oneTimeResponse: true }];
  return <main><h1>Tenant machine credentials</h1><ResourcePanel title="OAuth applications" listPath={`${root}/oauth-applications`} createPath={`${root}/oauth-applications`} itemPath={(item) => `${root}/oauth-applications/${itemId(item)}`} actions={credentialActions("oauth-applications")} oneTimeCreateResponse permissions={permissions} /><ResourcePanel title="Service identities" listPath={`${root}/service-identities`} createPath={`${root}/service-identities`} itemPath={(item) => `${root}/service-identities/${itemId(item)}`} actions={credentialActions("service-identities")} oneTimeCreateResponse permissions={permissions} /></main>;
}

function QuotaEditor({ path }: { path: string }) {
  const [current, setCurrent] = useState<unknown>();
  const [ready, setReady] = useState(false);
  const [saved, setSaved] = useState<unknown>();
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    let active = true;
    apiRequest(path)
      .then((value) => { if (active) { setCurrent(value); setReady(true); } })
      .catch((cause) => { if (active) setError(cause); });
    return () => { active = false; };
  }, [path]);
  return <section><ReadOnlyPanel title="Quota" path={path} />{error ? <ErrorState error={error} /> : null}<JsonPayloadForm submitLabel="Save" disabled={!ready} onSubmit={async (body) => { setError(undefined); try { const result = await apiRequest(path, { method: "PATCH", body: buildQuotaMutation(current, body) }); setCurrent(result); setSaved(result); } catch (cause) { setError(cause); throw cause; } }} />{saved ? <pre>{JSON.stringify(saved, null, 2)}</pre> : null}</section>;
}

function BillingPage({ root }: { root: string }) {
  return <main><h1>Billing and quota</h1><ReadOnlyPanel title="Billing account" path={`${root}/billing`} /><ReadOnlyPanel title="Transactions" path={`${root}/billing/transactions`} /><ReadOnlyPanel title="Usage records" path={`${root}/billing/usage-records`} /><QuotaEditor path={`${root}/quota`} /><section><h2>Top up / redeem voucher</h2><JsonPayloadForm submitLabel="Top up" onSubmit={async (body) => { await apiRequest(`${root}/billing/top-up`, { method: "POST", body }); }} /></section></main>;
}

function AuditPage({ root }: { root: string }) {
  const [queries, setQueries] = useState({ list: "", export: "" });
  const [exported, setExported] = useState<unknown>();
  const [error, setError] = useState<unknown>();
  return <main><h1>Audit log</h1><JsonPayloadForm submitLabel="Apply filters" initialValue={{ action: "", actor: "", resourceType: "", from: "", to: "", limit: 100, format: "json" }} onSubmit={(body) => setQueries(buildAuditQueries(body))} /><ReadOnlyPanel title="Audit records" path={`${root}/audit-log${queries.list}`} />{error ? <ErrorState error={error} /> : null}<button type="button" onClick={() => { setError(undefined); apiRequest(`${root}/audit-log/export${queries.export}`).then(setExported).catch(setError); }}>Export</button>{exported !== undefined ? <details open><summary>Export output</summary><pre>{formatAuditExport(exported)}</pre></details> : null}</main>;
}

function OperationsPage({ tenantId, root, operationId }: { tenantId: string; root: string; operationId?: string }) {
  if (!operationId) return <main><h1>Operations / jobs</h1><ResourcePanel title="Operations" listPath={`${root}/operations`} detailHref={(item) => `/tenants/${enc(tenantId)}/operations/${itemId(item)}`} actions={[{ label: "Retry", method: "POST", path: (item) => `${root}/operations/${itemId(item)}/retry` }]} /></main>;
  const path = `${root}/operations/${enc(operationId)}`;
  return <main><p><a href={`/tenants/${enc(tenantId)}/operations`}>← Operations</a></p><h1>Operation {operationId}</h1><ReadOnlyPanel title="Operation detail" path={path} /><ReadOnlyPanel title="Operation events" path={`${path}/events`} /><MutationButton label="Manual retry" path={`${path}/retry`} /></main>;
}
