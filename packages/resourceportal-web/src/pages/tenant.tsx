import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../api/client";
import { ConfirmButton, JsonPayloadForm, OneTimeCredential } from "../components/forms";
import { ErrorState, ReadableDataView, ReadOnlyPanel, ResourcePanel } from "../components/resource";
import { buildAuditQueries, formatAuditExport } from "./audit-query";
import {
  appGroupForm,
  attachConfigForm,
  attachSecretForm,
  attachVariableForm,
  attachVolumeForm,
  auditFilterForm,
  authPolicyForm,
  configForm,
  customRootDomainForm,
  customRootDomainUpdateForm,
  deployForm,
  domainForm,
  domainUpdateForm,
  groupForm,
  httpEndpointForm,
  identityProviderForm,
  invitationForm,
  membershipUpdateForm,
  oauthApplicationForm,
  oauthApplicationUpdateForm,
  quotaForm,
  registryForm,
  resizeVolumeForm,
  rollbackForm,
  runtimeConfigForm,
  secretForm,
  singleAppForm,
  tenantServiceIdentityForm,
  tenantServiceIdentityUpdateForm,
  topUpForm,
  variableForm,
  volumeForm,
} from "./form-templates";
import { buildQuotaMutation } from "./quota-payload";
import { TenantDashboard } from "./tenant-dashboard";
import { AppGroupWorkspace } from "./app-group-workspace";

const enc = encodeURIComponent;
const itemId = (item: Record<string, unknown>) => enc(String(item.id ?? ""));

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function resourceLabel(item: Record<string, unknown>) {
  for (const key of ["displayName", "name", "email", "id"]) {
    if (typeof item[key] === "string" && item[key]) return String(item[key]);
  }
  return "Selected resource";
}

function prefill(template: Record<string, unknown>, current: unknown) {
  if (!isRecord(current)) return template;
  return Object.fromEntries(Object.entries(template).map(([key, fallback]) => [key, current[key] === undefined ? fallback : current[key]]));
}

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
  const [success, setSuccess] = useState<string>();
  const action = async () => {
    setWorking(true); setError(undefined); setSuccess(undefined);
    try { await apiRequest(path, { method }); setSuccess(`${label} completed.`); }
    catch (cause) { setError(cause); }
    finally { setWorking(false); }
  };
  return <>{confirm ? <ConfirmButton confirm={confirm} onConfirm={action}>{label}</ConfirmButton> : <button type="button" disabled={working} onClick={() => void action()}>{working ? "Working…" : label}</button>}{error ? <ErrorState error={error} /> : null}{success ? <p className="rp-success-message" role="status">{success}</p> : null}</>;
}

function PatchSingleton({ title, path, initialValue }: { title: string; path: string; initialValue: Record<string, unknown> }) {
  const [current, setCurrent] = useState<unknown>();
  const [error, setError] = useState<unknown>();
  const [success, setSuccess] = useState<string>();
  useEffect(() => { apiRequest(path).then(setCurrent).catch(setError); }, [path]);
  const formValue = useMemo(() => prefill(initialValue, current), [current, initialValue]);
  return <section className="rp-settings-editor"><header><div><p className="rp-eyebrow">Configuration</p><h2>{title}</h2></div></header>{error ? <ErrorState error={error} /> : null}{success ? <p className="rp-success-message" role="status">{success}</p> : null}{current === undefined ? <p>Loading…</p> : <JsonPayloadForm initialValue={formValue} submitLabel="Save" onSubmit={async (body) => { setSuccess(undefined); try { const result = await apiRequest(path, { method: "PATCH", body }); setCurrent(result); setSuccess(`${title} saved.`); } catch (cause) { setError(cause); throw cause; } }} />}</section>;
}

export function TenantPage({ tenantId, section, resourceId, userId }: { tenantId: string; section: string; resourceId?: string; userId: string }) {
  const root = `/api/tenants/${enc(tenantId)}`;
  const [permissions, setPermissions] = useState<string[] | undefined>();
  useEffect(() => { apiRequest(`${root}/memberships`).then((value) => setPermissions(collectPermissions(value, userId))).catch(() => setPermissions(undefined)); }, [root, userId]);

  if (section === "overview") return <TenantDashboard tenantId={tenantId} />;
  if (section === "app-groups") return resourceId ? <AppGroupPage tenantId={tenantId} appGroupId={resourceId} permissions={permissions} /> : <main><h1>AppGroups</h1><ResourcePanel title="AppGroups" listPath={`${root}/app-groups`} createPath={`${root}/app-groups`} createInitialValue={appGroupForm} deletePath={(item) => `${root}/app-groups/${itemId(item)}`} detailHref={(item) => `/tenants/${enc(tenantId)}/app-groups/${itemId(item)}`} createPermission="appgroup.create" deletePermission="appgroup.delete" permissions={permissions} /></main>;
  if (section === "volumes") return <main><h1>Volumes</h1><ResourcePanel title="Volumes" listPath={`${root}/volumes`} createPath={`${root}/volumes`} createInitialValue={volumeForm} actions={[{ label: "Grow / resize", method: "PATCH", path: (item) => `${root}/volumes/${itemId(item)}/resize`, body: true, initialValue: resizeVolumeForm }, { label: "Delete", method: "DELETE", path: (item) => `${root}/volumes/${itemId(item)}`, destructive: true }]} permissions={permissions} /></main>;
  if (section === "registries") return <main><h1>Registries</h1><ResourcePanel title="Registries" listPath={`${root}/registries`} createPath={`${root}/registries`} createInitialValue={registryForm} itemPath={(item) => `${root}/registries/${itemId(item)}`} actions={[{ label: "Validate", method: "POST", path: (item) => `${root}/registries/${itemId(item)}/validate` }]} permissions={permissions} /></main>;
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
  const [selectedSingleApp, setSelectedSingleApp] = useState<Record<string, unknown>>();
  return <AppGroupWorkspace
    tenantId={tenantId}
    appGroupId={appGroupId}
    apps={<><ResourcePanel title="SingleApps" listPath={`${root}/single-apps`} createPath={`${root}/single-apps`} createInitialValue={singleAppForm} itemPath={(item) => `${root}/single-apps/${itemId(item)}`} onSelect={setSelectedSingleApp} selectLabel="Configure" actions={[{ label: "Start", method: "POST", path: (item) => `${root}/single-apps/${itemId(item)}/runtime/start` }, { label: "Stop", method: "POST", path: (item) => `${root}/single-apps/${itemId(item)}/runtime/stop` }, { label: "Restart", method: "POST", path: (item) => `${root}/single-apps/${itemId(item)}/runtime/restart` }]} permissions={permissions} /><SingleAppWorkbench root={root} selected={selectedSingleApp} onClear={() => setSelectedSingleApp(undefined)} /></>}
    config={<><ResourcePanel title="Variables" listPath={`${root}/variables`} createPath={`${root}/variables`} createInitialValue={variableForm} itemPath={(item) => `${root}/variables/${itemId(item)}`} permissions={permissions} /><ResourcePanel title="Configs" listPath={`${root}/configs`} createPath={`${root}/configs`} createInitialValue={configForm} itemPath={(item) => `${root}/configs/${itemId(item)}`} permissions={permissions} /><ResourcePanel title="Secrets" listPath={`${root}/secrets`} createPath={`${root}/secrets`} createInitialValue={secretForm} itemPath={(item) => `${root}/secrets/${itemId(item)}`} help="Secret values are accepted only in mutation payloads; reads render backend metadata only." permissions={permissions} /></>}
    networking={<div className="rp-context-links"><p>HTTP endpoints are configured per SingleApp. Select an application above to manage endpoints and attachments.</p><a href={`/tenants/${enc(tenantId)}/domains`}>Manage tenant domains</a></div>}
    deployments={<DeploymentWorkbench root={root} />}
    activity={<div className="rp-context-links"><p>Deployment events live with each deployment. Tenant-wide execution and audit history remain available in Activity.</p><a href={`/tenants/${enc(tenantId)}/operations`}>Open Operations</a><a href={`/tenants/${enc(tenantId)}/audit`}>Open Audit log</a></div>}
    advanced={<><ReadOnlyPanel title="App Group detail" path={root} /><ReadOnlyPanel title="Stack preview" path={`${root}/stack-preview`} /><section><h2>Draft controls</h2><MutationButton label="Discard draft changes" path={`${root}/discard-changes`} confirm="Discard all draft changes?" /></section></>}
  />;
}

function DeploymentWorkbench({ root }: { root: string }) {
  const [selected, setSelected] = useState<Record<string, unknown>>();
  const [success, setSuccess] = useState<string>();
  const [error, setError] = useState<unknown>();
  const deploymentId = selected ? String(selected.id ?? "") : "";
  return <section><h2>Deployments</h2>{error ? <ErrorState error={error} /> : null}{success ? <p className="rp-success-message" role="status">{success}</p> : null}<JsonPayloadForm initialValue={deployForm} submitLabel="Deploy" onSubmit={async (body) => { setSuccess(undefined); try { const result = await apiRequest(`${root}/deploy`, { method: "POST", body, headers: { "idempotency-key": crypto.randomUUID() } }); if (isRecord(result) && result.id) setSelected(result); setSuccess("Deployment started."); } catch (cause) { setError(cause); throw cause; } }} /><ResourcePanel title="Deployment history" listPath={`${root}/deployments`} onSelect={setSelected} selectLabel="View details" actions={[{ label: "Rollback", method: "POST", path: (item) => `${root}/deployments/${itemId(item)}/rollback`, body: true, initialValue: rollbackForm }]} />{selected && deploymentId ? <div className="rp-selected-resource"><p>Selected deployment: <strong>{resourceLabel(selected)}</strong></p><button type="button" onClick={() => setSelected(undefined)}>Close details</button><ReadOnlyPanel title="Deployment detail" path={`${root}/deployments/${enc(deploymentId)}`} /><ReadOnlyPanel title="Deployment events" path={`${root}/deployments/${enc(deploymentId)}/events`} /></div> : <p>Select a deployment from the history to view its detail and events.</p>}</section>;
}

type AttachmentKind = "variable" | "config" | "secret" | "volume";

type AttachmentResource = Record<string, unknown> & { attachments?: unknown[] };

function payloadItems(payload: unknown): AttachmentResource[] {
  if (Array.isArray(payload)) return payload.filter((item): item is AttachmentResource => isRecord(item));
  if (isRecord(payload)) {
    for (const key of ["items", "records", "data", "results"]) {
      if (Array.isArray(payload[key])) return payloadItems(payload[key]);
    }
    return [payload];
  }
  return [];
}

function attachmentList(resource: AttachmentResource, singleAppId: string) {
  const attachments = Array.isArray(resource.attachments) ? resource.attachments : [];
  return attachments.filter((entry): entry is Record<string, unknown> => isRecord(entry) && entry.singleAppId === singleAppId);
}

function attachmentTarget(kind: AttachmentKind, attachment: Record<string, unknown>) {
  if (kind === "config") return String(attachment.targetPath ?? "Configured path");
  if (kind === "volume") {
    const path = String(attachment.mountPath ?? "Configured mount");
    const mode = typeof attachment.mode === "string" && attachment.mode ? ` (${attachment.mode})` : "";
    return `${path}${mode}`;
  }
  return String(attachment.targetName ?? "Configured target");
}

function attachmentResourceName(resource: AttachmentResource) {
  return String(resource.displayName ?? resource.name ?? resource.id ?? "Resource");
}

function AttachmentManager({ root, appRoot, singleAppId }: { root: string; appRoot: string; singleAppId: string }) {
  const tenantRoot = root.split("/app-groups/")[0];
  const [resources, setResources] = useState<Record<AttachmentKind, AttachmentResource[]>>({ variable: [], config: [], secret: [], volume: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [success, setSuccess] = useState<string>();

  async function reload() {
    setLoading(true);
    setError(undefined);
    try {
      const [variables, configs, secrets, volumes] = await Promise.all([
        apiRequest(`${root}/variables`),
        apiRequest(`${root}/configs`),
        apiRequest(`${root}/secrets`),
        apiRequest(`${tenantRoot}/volumes`),
      ]);
      setResources({
        variable: payloadItems(variables),
        config: payloadItems(configs),
        secret: payloadItems(secrets),
        volume: payloadItems(volumes),
      });
    } catch (cause) {
      setError(cause);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [root, tenantRoot, singleAppId]);

  const forms: Record<AttachmentKind, Record<string, unknown>> = {
    variable: attachVariableForm,
    config: attachConfigForm,
    secret: attachSecretForm,
    volume: attachVolumeForm,
  };
  const resourceIdFields: Record<AttachmentKind, string> = { variable: "variableId", config: "configId", secret: "secretId", volume: "volumeId" };
  const kinds: AttachmentKind[] = ["variable", "config", "secret", "volume"];

  async function attach(kind: AttachmentKind, body: Record<string, unknown>) {
    setSuccess(undefined);
    setError(undefined);
    try {
      await apiRequest(`${appRoot}/${kind}-attachments`, { method: "POST", body });
      setSuccess(`${kind[0].toUpperCase()}${kind.slice(1)} attached.`);
      await reload();
    } catch (cause) {
      setError(cause);
      throw cause;
    }
  }

  async function detach(kind: AttachmentKind, attachment: Record<string, unknown>, name: string) {
    const attachmentId = String(attachment.id ?? "");
    if (!attachmentId) return;
    setSuccess(undefined);
    setError(undefined);
    try {
      await apiRequest(`${appRoot}/${kind}-attachments/${enc(attachmentId)}`, { method: "DELETE" });
      setSuccess(`${name} detached.`);
      await reload();
    } catch (cause) {
      setError(cause);
    }
  }

  return <section className="rp-attachment-manager">
    <header><div><p className="rp-eyebrow">Application configuration</p><h3>Attachments</h3><p>Connect existing configuration and storage to this application by name.</p></div></header>
    {error ? <ErrorState error={error} /> : null}
    {success ? <p className="rp-success-message" role="status">{success}</p> : null}
    {loading ? <p>Loading attachments…</p> : <div className="rp-attachment-grid">{kinds.map((kind) => {
      const label = `${kind[0].toUpperCase()}${kind.slice(1)}`;
      const sourceResources = resources[kind];
      const attached = sourceResources.flatMap((resource) => attachmentList(resource, singleAppId).map((attachment) => ({ resource, attachment })));
      const referenceOptions = {
        [resourceIdFields[kind]]: sourceResources.map((resource) => ({ value: String(resource.id ?? ""), label: attachmentResourceName(resource) })).filter((option) => option.value),
      };
      return <article className="rp-attachment-card" key={kind}>
        <div className="rp-attachment-card-header"><div><h4>{label}s</h4><p>{attached.length ? `${attached.length} attached` : "Nothing attached"}</p></div></div>
        {attached.length ? <ul className="rp-attachment-list">{attached.map(({ resource, attachment }) => {
          const name = attachmentResourceName(resource);
          return <li key={String(attachment.id ?? `${kind}-${name}`)}><span>{name} → {attachmentTarget(kind, attachment)}</span><button type="button" onClick={() => void detach(kind, attachment, name)} aria-label={`Detach ${kind} ${name}`}>Detach</button></li>;
        })}</ul> : <p className="rp-data-muted">No {kind}s attached to this application.</p>}
        <div className="rp-attachment-form"><h5>Attach {kind}</h5><JsonPayloadForm initialValue={forms[kind]} referenceOptions={referenceOptions} submitLabel={`Attach ${kind}`} onSubmit={(body) => attach(kind, body)} /></div>
      </article>;
    })}</div>}
  </section>;
}

function SingleAppWorkbench({ root, selected, onClear }: { root: string; selected?: Record<string, unknown>; onClear: () => void }) {
  const singleAppId = selected ? String(selected.id ?? "") : "";
  const appRoot = `${root}/single-apps/${enc(singleAppId)}`;
  return <section><h2>SingleApp configuration / attachments / HTTP endpoints</h2>{selected && singleAppId ? <><div className="rp-selected-resource"><p>Selected application: <strong>{resourceLabel(selected)}</strong></p><button type="button" onClick={onClear}>Change application</button></div><PatchSingleton title="Runtime / resource configuration" path={`${appRoot}/runtime-config`} initialValue={runtimeConfigForm} /><ResourcePanel title="HTTP endpoints" listPath={`${appRoot}/http-endpoints`} createPath={`${appRoot}/http-endpoints`} createInitialValue={httpEndpointForm} itemPath={(item) => `${appRoot}/http-endpoints/${itemId(item)}`} /><AttachmentManager root={root} appRoot={appRoot} singleAppId={singleAppId} /></> : <p>Select a SingleApp from the list above to manage its configuration, endpoints, and attachments.</p>}</section>;
}

function AdvancedDomainEndpointAssignment({ root }: { root: string }) {
  const [domains, setDomains] = useState<AttachmentResource[]>([]);
  const [error, setError] = useState<unknown>();
  const [success, setSuccess] = useState<string>();

  useEffect(() => {
    let active = true;
    apiRequest(`${root}/domains`)
      .then((value) => { if (active) setDomains(payloadItems(value)); })
      .catch((cause) => { if (active) setError(cause); });
    return () => { active = false; };
  }, [root]);

  const referenceOptions = {
    domainId: domains
      .map((domain) => ({
        value: String(domain.id ?? ""),
        label: String(domain.hostname ?? domain.prefix ?? domain.subdomain ?? domain.id ?? "Domain"),
      }))
      .filter((option) => option.value),
  };

  return <details className="rp-advanced-panel">
    <summary>Advanced endpoint assignment</summary>
    <section role="group" aria-label="Advanced endpoint assignment" className="rp-advanced-body">
      <p>Use this only when you need to bind an existing domain to a specific SingleApp HTTP endpoint. The endpoint ID is available in that endpoint's View details panel.</p>
      {error ? <ErrorState error={error} /> : null}
      {success ? <p className="rp-success-message" role="status">{success}</p> : null}
      <JsonPayloadForm
        initialValue={{ domainId: "", httpEndpointId: "" }}
        referenceOptions={referenceOptions}
        submitLabel="Assign endpoint"
        onSubmit={async (body) => {
          const domainId = String(body.domainId ?? "");
          const httpEndpointId = String(body.httpEndpointId ?? "");
          if (!domainId || !httpEndpointId) throw new Error("Domain and HTTP endpoint are required");
          setSuccess(undefined);
          await apiRequest(`${root}/domains/${enc(domainId)}`, { method: "PATCH", body: { httpEndpointId } });
          setSuccess("HTTP endpoint assigned.");
        }}
      />
    </section>
  </details>;
}

function DomainPage({ root }: { root: string }) {
  return <main><h1>Domains and HTTP routing</h1><ResourcePanel title="Domains" listPath={`${root}/domains`} createPath={`${root}/domains`} createInitialValue={domainForm} updateInitialValue={domainUpdateForm} itemPath={(item) => `${root}/domains/${itemId(item)}`} actions={[{ label: "Validate", method: "POST", path: (item) => `${root}/domains/${itemId(item)}/validate` }]} /><ResourcePanel title="Custom root domains" listPath={`${root}/domains/custom-root-domains`} createPath={`${root}/domains/custom-root-domains`} createInitialValue={customRootDomainForm} updateInitialValue={customRootDomainUpdateForm} itemPath={(item) => `${root}/domains/custom-root-domains/${itemId(item)}`} actions={[{ label: "Validate", method: "POST", path: (item) => `${root}/domains/custom-root-domains/${itemId(item)}/validate` }]} /><AdvancedDomainEndpointAssignment root={root} /></main>;
}

function AdministrationPage({ root, permissions }: { root: string; permissions?: string[] }) {
  return <main><h1>Tenant administration</h1><ResourcePanel title="Invitations" listPath={`${root}/invitations`} createPath={`${root}/invitations`} createInitialValue={invitationForm} actions={[{ label: "Resend", method: "POST", path: (item) => `${root}/invitations/${itemId(item)}/resend` }, { label: "Delete", method: "DELETE", path: (item) => `${root}/invitations/${itemId(item)}`, destructive: true }]} permissions={permissions} help="Invite people by email and choose the roles they should receive." /><ResourcePanel title="Memberships" listPath={`${root}/memberships`} updateInitialValue={membershipUpdateForm} itemPath={(item) => `${root}/memberships/${itemId(item)}`} permissions={permissions} help="Existing tenant access. Add people through Invitations instead of entering user IDs." /><ReadOnlyPanel title="Roles" path={`${root}/roles`} /><ResourcePanel title="Groups" listPath={`${root}/groups`} createPath={`${root}/groups`} createInitialValue={groupForm} itemPath={(item) => `${root}/groups/${itemId(item)}`} permissions={permissions} /><PatchSingleton title="Authentication policy" path={`${root}/auth-policy`} initialValue={authPolicyForm} /><ResourcePanel title="Identity providers" listPath={`${root}/identity-providers`} createPath={`${root}/identity-providers`} createInitialValue={identityProviderForm} itemPath={(item) => `${root}/identity-providers/${itemId(item)}`} permissions={permissions} /></main>;
}

function CredentialPage({ root, permissions }: { root: string; permissions?: string[] }) {
  const credentialActions = (resource: string) => [{ label: "Rotate credentials", method: "POST" as const, path: (item: Record<string, unknown>) => `${root}/${resource}/${itemId(item)}/rotate-credentials`, oneTimeResponse: true }];
  return <main><h1>Tenant machine credentials</h1><ResourcePanel title="OAuth applications" listPath={`${root}/oauth-applications`} createPath={`${root}/oauth-applications`} createInitialValue={oauthApplicationForm} updateInitialValue={oauthApplicationUpdateForm} itemPath={(item) => `${root}/oauth-applications/${itemId(item)}`} actions={credentialActions("oauth-applications")} oneTimeCreateResponse permissions={permissions} /><ResourcePanel title="Service identities" listPath={`${root}/service-identities`} createPath={`${root}/service-identities`} createInitialValue={tenantServiceIdentityForm} updateInitialValue={tenantServiceIdentityUpdateForm} itemPath={(item) => `${root}/service-identities/${itemId(item)}`} actions={credentialActions("service-identities")} oneTimeCreateResponse permissions={permissions} /></main>;
}

function QuotaEditor({ path }: { path: string }) {
  const [current, setCurrent] = useState<unknown>();
  const [ready, setReady] = useState(false);
  const [success, setSuccess] = useState<string>();
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    let active = true;
    apiRequest(path)
      .then((value) => { if (active) { setCurrent(value); setReady(true); } })
      .catch((cause) => { if (active) setError(cause); });
    return () => { active = false; };
  }, [path]);
  const formValue = useMemo(() => prefill(quotaForm, current), [current]);
  return <section className="rp-settings-editor"><header><div><p className="rp-eyebrow">Limits</p><h2>Quota</h2></div></header>{error ? <ErrorState error={error} /> : null}{success ? <p className="rp-success-message" role="status">{success}</p> : null}{!ready ? <p>Loading…</p> : <JsonPayloadForm initialValue={formValue} submitLabel="Save" disabled={!ready} onSubmit={async (body) => { setError(undefined); setSuccess(undefined); try { const result = await apiRequest(path, { method: "PATCH", body: buildQuotaMutation(current, body) }); setCurrent(result); setSuccess("Quota saved."); } catch (cause) { setError(cause); throw cause; } }} />}</section>;
}

function TopUpEditor({ path }: { path: string }) {
  const [success, setSuccess] = useState<string>();
  const [error, setError] = useState<unknown>();
  return <section className="rp-action-panel"><h2>Top up / redeem voucher</h2>{error ? <ErrorState error={error} /> : null}{success ? <p className="rp-success-message" role="status">{success}</p> : null}<JsonPayloadForm initialValue={topUpForm} submitLabel="Top up" onSubmit={async (body) => { setSuccess(undefined); try { await apiRequest(path, { method: "POST", body }); setSuccess("Balance updated."); } catch (cause) { setError(cause); throw cause; } }} /></section>;
}

function BillingPage({ root }: { root: string }) {
  return <main><h1>Billing and quota</h1><ReadOnlyPanel title="Billing account" path={`${root}/billing`} /><ReadOnlyPanel title="Transactions" path={`${root}/billing/transactions`} /><ReadOnlyPanel title="Usage records" path={`${root}/billing/usage-records`} /><QuotaEditor path={`${root}/quota`} /><TopUpEditor path={`${root}/billing/top-up`} /></main>;
}

function AuditPage({ root }: { root: string }) {
  const [queries, setQueries] = useState({ list: "", export: "" });
  const [exported, setExported] = useState<unknown>();
  const [error, setError] = useState<unknown>();
  const format = new URLSearchParams(queries.export.replace(/^\?/, "")).get("format") ?? "json";
  const exportText = exported === undefined ? undefined : formatAuditExport(exported);
  const mime = format === "csv" ? "text/csv" : "application/json";
  const extension = format === "csv" ? "csv" : "json";
  const downloadHref = exportText === undefined ? undefined : `data:${mime};charset=utf-8,${encodeURIComponent(exportText)}`;
  return <main><h1>Audit log</h1><JsonPayloadForm submitLabel="Apply filters" initialValue={auditFilterForm} onSubmit={(body) => { setExported(undefined); setQueries(buildAuditQueries(body)); }} /><ReadOnlyPanel title="Audit records" path={`${root}/audit-log${queries.list}`} />{error ? <ErrorState error={error} /> : null}<div className="rp-export-actions"><button type="button" onClick={() => { setError(undefined); setExported(undefined); apiRequest(`${root}/audit-log/export${queries.export}`).then(setExported).catch(setError); }}>Export</button>{downloadHref ? <a className="rp-download-link" href={downloadHref} download={`audit-log.${extension}`}>Download audit export</a> : null}</div></main>;
}

function OperationsPage({ tenantId, root, operationId }: { tenantId: string; root: string; operationId?: string }) {
  if (!operationId) return <main><h1>Operations / jobs</h1><ResourcePanel title="Operations" listPath={`${root}/operations`} detailHref={(item) => `/tenants/${enc(tenantId)}/operations/${itemId(item)}`} actions={[{ label: "Retry", method: "POST", path: (item) => `${root}/operations/${itemId(item)}/retry` }]} /></main>;
  const path = `${root}/operations/${enc(operationId)}`;
  return <main><p><a href={`/tenants/${enc(tenantId)}/operations`}>← Operations</a></p><h1>Operation {operationId}</h1><ReadOnlyPanel title="Operation detail" path={path} /><ReadOnlyPanel title="Operation events" path={`${path}/events`} /><MutationButton label="Manual retry" path={`${path}/retry`} /></main>;
}
