import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { apiRequest } from "../api/client";
import {
  ActivityIcon,
  BillingIcon,
  Button,
  Callout,
  Card,
  DataTable,
  DetailList,
  Dialog,
  EmptyState,
  Field,
  GridIcon,
  KeyIcon,
  LinkButton,
  LockIcon,
  MetricCard,
  NetworkIcon,
  NumberInput,
  PageHeader,
  Select,
  ServerIcon,
  SettingsIcon,
  StatusBadge,
  Textarea,
  TextInput,
  UsersIcon,
  statusTone,
} from "../components/design-system";
import { asRecord, formatBytes, formatDate, idOf, items, numberOf, text, useApi } from "../hooks/use-api";
import { tenantHref } from "../router/router";

type Row = Record<string, unknown>;
type Notice = { tone: "success" | "danger" | "warning" | "info"; message: string } | undefined;

function titleCase(value: unknown) {
  return text(value, "Unknown").replaceAll("_", " ").replaceAll("-", " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function bool(value: unknown) { return value === true || value === "true"; }
function valueOf(row: Row, ...keys: string[]) { for (const key of keys) if (row[key] !== undefined && row[key] !== null && row[key] !== "") return row[key]; return undefined; }
function readableError(error: unknown) { return error instanceof Error ? error.message : "The request could not be completed."; }
function scalarPairs(row: Row, allow: string[]) { return allow.filter((key) => row[key] !== undefined && row[key] !== null && typeof row[key] !== "object").map((key) => ({ label: titleCase(key), value: text(row[key]) })); }

function SectionTitle({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: ReactNode }) {
  return <div className="flex flex-col justify-between gap-3 border-b border-[#E1E7F0] px-5 py-4 sm:flex-row sm:items-center"><div>{eyebrow ? <p className="text-[11px] font-semibold uppercase tracking-[.06em] text-[#1769E0]">{eyebrow}</p> : null}<h2 className="mt-0.5 text-lg font-semibold text-[#172033]">{title}</h2>{description ? <p className="mt-1 text-xs text-[#718096]">{description}</p> : null}</div>{action}</div>;
}

function NoticeCallout({ notice }: { notice: Notice }) { return notice ? <div role={notice.tone === "danger" ? "alert" : "status"}><Callout tone={notice.tone} title={notice.message} /></div> : null; }
function LoadingCard({ label }: { label: string }) { return <Card className="p-5 text-sm text-[#5B6678]">Loading {label}…</Card>; }
function ErrorCard({ label, error, retry }: { label: string; error: unknown; retry?: () => void }) { return <Callout tone="danger" title={`${label} unavailable`} action={retry ? <Button size="sm" onClick={retry}>Retry</Button> : undefined}>{readableError(error)}</Callout>; }

export function PlatformOverviewPage() {
  const health = useApi<Row>("/api/health");
  const tenants = useApi<unknown>("/api/tenants", []);
  const swarm = useApi<Row>("/api/platform/swarm-cluster");
  const backends = useApi<unknown>("/api/platform/storage-backends", []);
  const idps = useApi<unknown>("/api/platform/identity-providers", []);
  const prices = useApi<unknown>("/api/platform/billing/price-lists", []);
  const maintenance = useApi<Row>("/api/platform/maintenance");
  const tenantRows = items<Row>(tenants.data);
  const backendRows = items<Row>(backends.data);
  const idpRows = items<Row>(idps.data);
  const priceRows = items<Row>(prices.data);
  const swarmRow = asRecord(swarm.data);
  const swarmState = text(valueOf(swarmRow, "health", "status"), "Unknown");
  const nodeCount = numberOf(valueOf(swarmRow, "nodeCount", "nodes"), 0);
  const unhealthyBackends = backendRows.filter((row) => !["ready", "healthy"].includes(text(valueOf(row, "status", "health"), "unknown").toLowerCase()));
  const dependencies = asRecord(health.data?.dependencies);
  const apiState = health.error ? "Unavailable" : titleCase(health.data?.status);
  const postgresState = health.error ? "Unavailable" : titleCase(dependencies.postgres);
  const storageState = backends.error ? "Unavailable" : backends.loading ? "Checking" : unhealthyBackends.length ? "Attention" : "Healthy";

  const adminRows = [
    { label: "Maintenance", detail: maintenance.loading ? "Checking" : maintenance.error ? "Unavailable" : maintenance.data?.enabled ? "Enabled" : "Disabled", href: "/platform/maintenance", tone: maintenance.error ? "danger" : maintenance.data?.enabled ? "warning" : "success" },
    { label: "Identity providers", detail: idps.loading ? "Loading" : idps.error ? "Unavailable" : `${idpRows.length} configured`, href: "/platform/identity-providers", tone: idps.error ? "danger" : "neutral" },
    { label: "Price lists", detail: prices.loading ? "Loading" : prices.error ? "Unavailable" : `${priceRows.length} configured`, href: "/platform/billing", tone: prices.error ? "danger" : priceRows.length ? "success" : "warning" },
    { label: "Storage alerts", detail: backends.loading ? "Loading" : backends.error ? "Unavailable" : unhealthyBackends.length ? `${unhealthyBackends.length} active` : "None", href: "/platform/infrastructure", tone: backends.error ? "danger" : unhealthyBackends.length ? "warning" : "success" },
  ] as const;

  return <main>
    <PageHeader eyebrow="Platform" title="Platform overview" description="System-wide health and administration across ResourcePortal infrastructure and accessible tenants." />
    <section aria-label="Platform summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <MetricCard label="Tenants" value={String(tenantRows.length)} icon={<UsersIcon />} loading={tenants.loading} error={tenants.error} detail="Accessible to this administrator" />
      <MetricCard label="Swarm nodes" value={String(nodeCount)} icon={<ServerIcon />} loading={swarm.loading} error={swarm.error} tone={statusTone(swarmState)} detail={swarmState} />
      <MetricCard label="Storage backends" value={String(backendRows.length)} icon={<NetworkIcon />} loading={backends.loading} error={backends.error} tone={unhealthyBackends.length ? "warning" : "success"} detail={unhealthyBackends.length ? `${unhealthyBackends.length} need attention` : "No known storage alerts"} />
      <MetricCard label="Identity providers" value={String(idpRows.length)} icon={<KeyIcon />} loading={idps.loading} error={idps.error} detail={`${idpRows.filter((row) => bool(row.enabled)).length} enabled`} />
    </section>
    <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,.85fr)]">
      <Card className="overflow-hidden">
        <SectionTitle title="Platform health" description="Live status from platform-scoped health and infrastructure APIs." />
        <div className="p-5"><DetailList columns={1} items={[
          { label: "API", value: <StatusBadge tone={statusTone(apiState)}>{apiState}</StatusBadge> },
          { label: "PostgreSQL", value: <StatusBadge tone={statusTone(postgresState)}>{postgresState}</StatusBadge> },
          { label: "Docker Swarm", value: <StatusBadge tone={statusTone(swarmState)}>{swarm.loading ? "Checking" : swarm.error ? "Unavailable" : swarmState}</StatusBadge> },
          { label: "Storage", value: <StatusBadge tone={storageState === "Healthy" ? "success" : storageState === "Attention" ? "warning" : storageState === "Unavailable" ? "danger" : "info"}>{storageState}</StatusBadge> },
        ]} /></div>
      </Card>
      <Card className="overflow-hidden">
        <SectionTitle title="Administration" description="Open the platform controls represented by current APIs." />
        <div className="divide-y divide-[#E1E7F0] px-5">
          {adminRows.map((row) => <a key={row.label} href={row.href} className="flex items-center justify-between gap-4 py-4 text-[13px] hover:text-[#0F56A7]"><span className="font-medium text-[#172033]">{row.label}</span><span className="flex items-center gap-2"><StatusBadge tone={row.tone}>{row.detail}</StatusBadge><span aria-hidden="true" className="text-[#718096]">›</span></span></a>)}
        </div>
      </Card>
    </div>
  </main>;
}

export function PlatformTenantsPage() {
  const tenants = useApi<unknown>("/api/tenants", []);
  const rows = items<Row>(tenants.data);
  return <main>
    <PageHeader eyebrow="Platform Admin" title="Tenants" description="Tenant workspaces visible to the signed-in administrator, with direct access to billing, activity and administration." />
    <Callout title="Platform-global tenant inventory is not exposed by the API">This view contains tenants returned by the current `/tenants` endpoint. It does not pretend to be a global super-admin tenant list.</Callout>
    <section className="mt-6" aria-label="Tenant list">
      {tenants.error ? <ErrorCard label="Tenants" error={tenants.error} retry={tenants.reload} /> : <DataTable loading={tenants.loading} columns={[{ key: "tenant", label: "Tenant" },{ key: "role", label: "Role" },{ key: "billing", label: "Billing" },{ key: "quota", label: "Quota" },{ key: "actions", label: "Actions" }]} rows={rows.map((row) => { const id = idOf(row); const name = text(valueOf(row, "displayName", "name"), "Unnamed tenant"); return { key: id || name, cells: { tenant: <div><strong className="block text-[#172033]">{name}</strong><span className="text-xs text-[#718096]">{text(row.slug, "No slug")}</span></div>, role: titleCase(row.role), billing: <StatusBadge tone={statusTone(valueOf(row, "billingState", "billingStatus", "status"))}>{titleCase(valueOf(row, "billingState", "billingStatus", "status"))}</StatusBadge>, quota: text(valueOf(row, "quota", "quotaState"), "Managed in tenant"), actions: id ? <div className="flex flex-wrap gap-2"><LinkButton className="h-8 px-3 text-xs" href={tenantHref(id, "overview")}>Open</LinkButton><LinkButton className="h-8 px-3 text-xs" href={tenantHref(id, "billing")}>Billing</LinkButton><LinkButton className="h-8 px-3 text-xs" href={tenantHref(id, "activity")}>Activity</LinkButton></div> : "—" } }; })} empty={<EmptyState icon={<UsersIcon />} title="No accessible tenants" description="The current account has no tenant memberships returned by the API." />} footer={`${rows.length} tenant${rows.length === 1 ? "" : "s"} visible`} />}
    </section>
  </main>;
}

export function PlatformInfrastructurePage() {
  const swarm = useApi<Row>("/api/platform/swarm-cluster");
  const remotes = useApi<unknown>("/api/platform/remote-locations", []);
  const backends = useApi<unknown>("/api/platform/storage-backends", []);
  const [notice, setNotice] = useState<Notice>();
  const [busy, setBusy] = useState<string>();
  const remoteRows = items<Row>(remotes.data); const backendRows = items<Row>(backends.data);
  async function run(label: string, path: string, reload?: () => Promise<void>) { setBusy(label); setNotice(undefined); try { await apiRequest(path, { method: "POST" }); if (reload) await reload(); setNotice({ tone: "success", message: `${label} completed.` }); } catch (error) { setNotice({ tone: "danger", message: `${label} failed: ${readableError(error)}` }); } finally { setBusy(undefined); } }
  const swarmRow = asRecord(swarm.data); const swarmState = text(valueOf(swarmRow, "health", "status"), "Unknown");
  return <main>
    <PageHeader eyebrow="Platform Admin" title="Infrastructure" description="Swarm health, remote locations and storage backends using platform infrastructure APIs." actions={<Button variant="primary" disabled={busy === "Reconcile Swarm cluster"} onClick={() => void run("Reconcile Swarm cluster", "/api/platform/swarm-cluster/reconcile", swarm.reload)}>Reconcile Swarm cluster</Button>} />
    <NoticeCallout notice={notice} />
    <section className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Infrastructure summary">
      <MetricCard label="Swarm health" value={swarmState} icon={<ServerIcon />} tone={statusTone(swarmState)} loading={swarm.loading} error={swarm.error} />
      <MetricCard label="Nodes" value={String(numberOf(valueOf(swarmRow, "nodeCount", "nodes"), 0))} icon={<GridIcon />} loading={swarm.loading} error={swarm.error} />
      <MetricCard label="Remote locations" value={String(remoteRows.length)} icon={<NetworkIcon />} loading={remotes.loading} error={remotes.error} />
      <MetricCard label="Storage backends" value={String(backendRows.length)} icon={<NetworkIcon />} loading={backends.loading} error={backends.error} />
    </section>
    <div className="mt-6 space-y-6">
      <Card className="overflow-hidden"><SectionTitle eyebrow="Compute" title="Swarm cluster" description="Current persisted/live platform cluster state." /><div className="p-5">{swarm.error ? <ErrorCard label="Swarm cluster" error={swarm.error} retry={swarm.reload} /> : swarm.loading ? <p className="text-sm text-[#5B6678]">Loading cluster state…</p> : <DetailList columns={3} items={[{ label: "Status", value: <StatusBadge tone={statusTone(swarmState)}>{swarmState}</StatusBadge> },{ label: "Nodes", value: numberOf(valueOf(swarmRow, "nodeCount", "nodes"), 0) },{ label: "Managers", value: numberOf(valueOf(swarmRow, "managerCount", "managers"), 0) },{ label: "Last synchronized", value: formatDate(valueOf(swarmRow, "lastSyncedAt", "updatedAt")) }]} />}</div></Card>
      <Card className="overflow-hidden"><SectionTitle eyebrow="Storage" title="Storage backends" description="Validate and reconcile existing backends. The API does not expose create/update/delete operations here." />{backends.error ? <div className="p-5"><ErrorCard label="Storage backends" error={backends.error} retry={backends.reload} /></div> : <DataTable className="rounded-none border-0" loading={backends.loading} columns={[{ key: "name", label: "Backend" },{ key: "status", label: "Status" },{ key: "capacity", label: "Capacity" },{ key: "available", label: "Available" },{ key: "actions", label: "Actions" }]} rows={backendRows.map((row) => { const id = idOf(row); const state = text(valueOf(row, "health", "status"), "Unknown"); return { key: id || text(row.name), cells: { name: <div><strong className="block text-[#172033]">{text(row.name, "Unnamed backend")}</strong><span className="text-xs text-[#718096]">{titleCase(row.type)}</span></div>, status: <div className="flex flex-wrap gap-2"><StatusBadge tone={statusTone(state)}>{state}</StatusBadge>{bool(row.maintenance) ? <StatusBadge tone="warning">Maintenance</StatusBadge> : null}</div>, capacity: formatBytes(row.capacityTotal), available: formatBytes(row.capacityAvailable), actions: id ? <div className="flex flex-wrap gap-2"><Button size="sm" disabled={Boolean(busy)} onClick={() => void run(`Validate ${text(row.name, "backend")}`, `/api/platform/storage-backends/${encodeURIComponent(id)}/validate`, backends.reload)}>Validate</Button></div> : "—" } }; })} empty={<EmptyState title="No storage backends" description="No storage backend is currently returned by the platform API." />} />}</Card>
      <Card className="overflow-hidden"><SectionTitle eyebrow="Locations" title="Remote locations" description="Discovered infrastructure locations. Maintenance state is managed per location by the platform API." />{remotes.error ? <div className="p-5"><ErrorCard label="Remote locations" error={remotes.error} retry={remotes.reload} /></div> : <DataTable className="rounded-none border-0" loading={remotes.loading} columns={[{ key: "name", label: "Location" },{ key: "status", label: "Status" },{ key: "type", label: "Type" },{ key: "updated", label: "Last update" }]} rows={remoteRows.map((row) => ({ key: idOf(row) || text(row.name), cells: { name: text(valueOf(row, "displayName", "name"), "Unnamed location"), status: <StatusBadge tone={statusTone(valueOf(row, "health", "status"))}>{titleCase(valueOf(row, "health", "status"))}</StatusBadge>, type: titleCase(valueOf(row, "type", "kind")), updated: formatDate(valueOf(row, "lastSyncedAt", "updatedAt")) } }))} empty={<EmptyState title="No remote locations" description="No remote locations are currently registered." />} />}</Card>
    </div>
  </main>;
}

type IdentityForm = { name: string; protocol: "OIDC" | "SAML"; issuer: string; metadataUrl: string; clientId: string; clientSecret: string; enabled: boolean };
const emptyIdentity: IdentityForm = { name: "", protocol: "OIDC", issuer: "", metadataUrl: "", clientId: "", clientSecret: "", enabled: true };

export function PlatformIdentityPage() {
  const providers = useApi<unknown>("/api/platform/identity-providers", []);
  const oauth = useApi<unknown>("/api/platform/oauth-applications", []);
  const identities = useApi<unknown>("/api/platform/service-identities", []);
  const [open, setOpen] = useState(false); const [form, setForm] = useState<IdentityForm>(emptyIdentity); const [notice, setNotice] = useState<Notice>(); const [busy, setBusy] = useState(false);
  const providerRows = items<Row>(providers.data); const oauthRows = items<Row>(oauth.data); const serviceRows = items<Row>(identities.data);
  async function createProvider(event: FormEvent) { event.preventDefault(); setBusy(true); setNotice(undefined); const body: Row = { name: form.name.trim(), protocol: form.protocol, enabled: form.enabled }; if (form.protocol === "OIDC") Object.assign(body, { issuer: form.issuer.trim(), clientId: form.clientId.trim(), clientSecret: form.clientSecret, scopes: ["openid", "profile", "email"], usePkce: true }); else Object.assign(body, { metadataUrl: form.metadataUrl.trim() }); try { await apiRequest("/api/platform/identity-providers", { method: "POST", body }); await providers.reload(); setOpen(false); setForm(emptyIdentity); setNotice({ tone: "success", message: "Identity provider created." }); } catch (error) { setNotice({ tone: "danger", message: `Identity provider creation failed: ${readableError(error)}` }); } finally { setBusy(false); } }
  async function action(label: string, path: string, init: Parameters<typeof apiRequest>[1] = { method: "POST" }) { setBusy(true); setNotice(undefined); try { await apiRequest(path, init); await providers.reload(); setNotice({ tone: "success", message: `${label} completed.` }); } catch (error) { setNotice({ tone: "danger", message: `${label} failed: ${readableError(error)}` }); } finally { setBusy(false); } }
  return <main>
    <PageHeader eyebrow="Platform Admin" title="Identity & access" description="Platform federation and machine identities backed by the real OIDC/SAML, OAuth application and service identity APIs." actions={<Button variant="primary" onClick={() => setOpen(true)}>Add identity provider</Button>} />
    <NoticeCallout notice={notice} />
    <section className="mt-6 grid gap-4 sm:grid-cols-3" aria-label="Identity summary"><MetricCard label="Identity providers" value={String(providerRows.length)} icon={<UsersIcon />} loading={providers.loading} error={providers.error} /><MetricCard label="OAuth applications" value={String(oauthRows.length)} icon={<KeyIcon />} loading={oauth.loading} error={oauth.error} /><MetricCard label="Service identities" value={String(serviceRows.length)} icon={<LockIcon />} loading={identities.loading} error={identities.error} /></section>
    <div className="mt-6 space-y-6">
      <Card className="overflow-hidden"><SectionTitle eyebrow="Federation" title="Identity providers" description="OIDC and SAML providers configured for platform sign-in." />{providers.error ? <div className="p-5"><ErrorCard label="Identity providers" error={providers.error} retry={providers.reload} /></div> : <DataTable className="rounded-none border-0" loading={providers.loading} columns={[{ key: "name", label: "Provider" },{ key: "protocol", label: "Protocol" },{ key: "status", label: "Status" },{ key: "source", label: "Issuer / metadata" },{ key: "actions", label: "Actions" }]} rows={providerRows.map((row) => { const id = idOf(row); const enabled = bool(row.enabled); return { key: id || text(row.name), cells: { name: text(row.name, "Unnamed provider"), protocol: titleCase(row.protocol), status: <StatusBadge tone={enabled ? "success" : "neutral"}>{enabled ? "Enabled" : "Disabled"}</StatusBadge>, source: text(valueOf(row, "issuer", "metadataUrl")), actions: id ? <div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy} onClick={() => void action(enabled ? "Disable identity provider" : "Enable identity provider", `/api/platform/identity-providers/${encodeURIComponent(id)}`, { method: "PATCH", body: { enabled: !enabled } })}>{enabled ? "Disable" : "Enable"}</Button></div> : "—" } }; })} empty={<EmptyState icon={<UsersIcon />} title="No platform identity providers" description="Add an OIDC or SAML provider when external federation is required." />} />}</Card>
      <div className="grid gap-6 xl:grid-cols-2"><Card className="overflow-hidden"><SectionTitle eyebrow="Credentials" title="OAuth applications" />{oauth.error ? <div className="p-5"><ErrorCard label="OAuth applications" error={oauth.error} retry={oauth.reload} /></div> : <DataTable className="rounded-none border-0" loading={oauth.loading} columns={[{ key: "name", label: "Application" },{ key: "status", label: "Status" },{ key: "type", label: "Type" }]} rows={oauthRows.map((row) => ({ key: idOf(row) || text(row.name), cells: { name: text(valueOf(row, "displayName", "name"), "Unnamed application"), status: <StatusBadge tone={statusTone(valueOf(row, "status", "enabled"))}>{row.enabled === false ? "Disabled" : titleCase(valueOf(row, "status", "enabled"))}</StatusBadge>, type: titleCase(valueOf(row, "type", "grantType")) } }))} empty={<EmptyState title="No OAuth applications" />} />}</Card><Card className="overflow-hidden"><SectionTitle eyebrow="Credentials" title="Service identities" />{identities.error ? <div className="p-5"><ErrorCard label="Service identities" error={identities.error} retry={identities.reload} /></div> : <DataTable className="rounded-none border-0" loading={identities.loading} columns={[{ key: "name", label: "Identity" },{ key: "status", label: "Status" },{ key: "created", label: "Created" }]} rows={serviceRows.map((row) => ({ key: idOf(row) || text(row.name), cells: { name: text(valueOf(row, "displayName", "name"), "Unnamed identity"), status: <StatusBadge tone={statusTone(valueOf(row, "status", "enabled"))}>{row.enabled === false ? "Disabled" : titleCase(valueOf(row, "status", "enabled"))}</StatusBadge>, created: formatDate(row.createdAt) } }))} empty={<EmptyState title="No service identities" />} />}</Card></div>
    </div>
    <Dialog open={open} onClose={() => setOpen(false)} title="Add identity provider" description="Create a platform-wide federation provider using the backend configuration API." actions={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" type="submit" form="identity-provider-form" disabled={busy || !form.name.trim()}>Create identity provider</Button></>}>
      <form id="identity-provider-form" className="space-y-4" onSubmit={(event) => void createProvider(event)}><Field label="Name" required><TextInput aria-label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field><Field label="Protocol" required><Select aria-label="Protocol" value={form.protocol} onChange={(e) => setForm({ ...form, protocol: e.target.value as "OIDC" | "SAML" })}><option value="OIDC">OIDC</option><option value="SAML">SAML</option></Select></Field>{form.protocol === "OIDC" ? <><Field label="Issuer URL" required><TextInput aria-label="Issuer URL" type="url" value={form.issuer} onChange={(e) => setForm({ ...form, issuer: e.target.value })} /></Field><Field label="Client ID" required><TextInput aria-label="Client ID" value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} /></Field><Field label="Client secret" required><TextInput aria-label="Client secret" type="password" value={form.clientSecret} onChange={(e) => setForm({ ...form, clientSecret: e.target.value })} /></Field></> : <Field label="Metadata URL" required><TextInput aria-label="Metadata URL" type="url" value={form.metadataUrl} onChange={(e) => setForm({ ...form, metadataUrl: e.target.value })} /></Field>}<label className="flex items-center gap-2 text-sm text-[#172033]"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />Enabled</label></form>
    </Dialog>
  </main>;
}

export function PlatformBillingPage() {
  const tenants = useApi<unknown>("/api/tenants", []); const prices = useApi<unknown>("/api/platform/billing/price-lists", []); const vouchers = useApi<unknown>("/api/platform/billing/vouchers", []);
  const tenantRows = items<Row>(tenants.data); const priceRows = items<Row>(prices.data); const voucherRows = items<Row>(vouchers.data);
  const [tenantId, setTenantId] = useState(""); const [notice, setNotice] = useState<Notice>(); const [voucherOpen, setVoucherOpen] = useState(false); const [credits, setCredits] = useState("100");
  const selectedTenant = tenantRows.find((row) => idOf(row) === tenantId);
  const billing = useApi<Row>(tenantId ? `/api/tenants/${encodeURIComponent(tenantId)}/billing` : undefined);
  const quota = useApi<Row>(tenantId ? `/api/tenants/${encodeURIComponent(tenantId)}/quota` : undefined);
  const transactions = useApi<unknown>(tenantId ? `/api/tenants/${encodeURIComponent(tenantId)}/billing/transactions?limit=20` : undefined, []);
  const usage = useApi<unknown>(tenantId ? `/api/tenants/${encodeURIComponent(tenantId)}/billing/usage-records?limit=20` : undefined, []);
  async function createVoucher(event: FormEvent) { event.preventDefault(); try { await apiRequest("/api/platform/billing/vouchers", { method: "POST", body: { valueCredits: credits } }); await vouchers.reload(); setVoucherOpen(false); setNotice({ tone: "success", message: "Voucher created." }); } catch (error) { setNotice({ tone: "danger", message: `Voucher creation failed: ${readableError(error)}` }); } }
  return <main>
    <PageHeader eyebrow="Platform Admin" title="Billing" description="Platform pricing, vouchers and per-tenant billing diagnostics using real billing endpoints." actions={<Button variant="primary" onClick={() => setVoucherOpen(true)}>Create voucher</Button>} />
    <NoticeCallout notice={notice} />
    <section className="mt-6 grid gap-4 sm:grid-cols-3"><MetricCard label="Price lists" value={String(priceRows.length)} icon={<BillingIcon />} loading={prices.loading} error={prices.error} /><MetricCard label="Vouchers" value={String(voucherRows.length)} icon={<BillingIcon />} loading={vouchers.loading} error={vouchers.error} /><MetricCard label="Accessible tenants" value={String(tenantRows.length)} icon={<UsersIcon />} loading={tenants.loading} error={tenants.error} /></section>
    <div className="mt-6 space-y-6"><Card className="overflow-hidden"><SectionTitle eyebrow="Tenant billing" title="Inspect a tenant" description="Choose by tenant name; internal identifiers are not exposed as the primary UX." /><div className="p-5"><Field label="Tenant"><Select value={tenantId} onChange={(e) => setTenantId(e.target.value)}><option value="">Select tenant</option>{tenantRows.map((row) => <option key={idOf(row)} value={idOf(row)}>{text(valueOf(row, "displayName", "name"), "Unnamed tenant")}</option>)}</Select></Field>{tenantId ? <div className="mt-5 grid gap-4 lg:grid-cols-2"><Card className="p-4"><h3 className="text-sm font-semibold">Account</h3>{billing.loading ? <p className="mt-3 text-sm text-[#718096]">Loading billing state…</p> : billing.error ? <p className="mt-3 text-sm text-[#C42B1C]">{readableError(billing.error)}</p> : <div className="mt-3"><DetailList items={scalarPairs(asRecord(billing.data), ["billingState", "state", "balanceCredits", "balancePln", "currency"])} /></div>}</Card><Card className="p-4"><h3 className="text-sm font-semibold">Quota</h3>{quota.loading ? <p className="mt-3 text-sm text-[#718096]">Loading quota…</p> : quota.error ? <p className="mt-3 text-sm text-[#C42B1C]">{readableError(quota.error)}</p> : <div className="mt-3"><DetailList items={scalarPairs(asRecord(quota.data), ["cpu", "memory", "storage", "gpu", "cpuLimit", "memoryLimit", "storageLimit", "gpuLimit"])} /></div>}</Card><Card className="p-4"><h3 className="text-sm font-semibold">Recent transactions</h3><p className="mt-2 text-2xl font-semibold">{items(transactions.data).length}</p><p className="text-xs text-[#718096]">records returned</p></Card><Card className="p-4"><h3 className="text-sm font-semibold">Usage samples</h3><p className="mt-2 text-2xl font-semibold">{items(usage.data).length}</p><p className="text-xs text-[#718096]">records returned</p></Card></div> : <div className="mt-5"><EmptyState title="Select a tenant" description="Billing state, quota, transactions and usage are tenant-scoped in the current API." /></div>}{selectedTenant && tenantId ? <div className="mt-4"><LinkButton href={tenantHref(tenantId, "billing")}>Open {text(valueOf(selectedTenant, "displayName", "name"), "tenant")} billing</LinkButton></div> : null}</div></Card>
      <div className="grid gap-6 xl:grid-cols-2"><Card className="overflow-hidden"><SectionTitle eyebrow="Pricing" title="Price lists" />{prices.error ? <div className="p-5"><ErrorCard label="Price lists" error={prices.error} retry={prices.reload} /></div> : <DataTable className="rounded-none border-0" loading={prices.loading} columns={[{ key: "effective", label: "Effective" },{ key: "cpu", label: "CPU / h" },{ key: "memory", label: "Memory / GB h" },{ key: "storage", label: "Storage / GB h" }]} rows={priceRows.map((row, index) => ({ key: idOf(row) || String(index), cells: { effective: formatDate(row.effectiveFrom), cpu: text(row.cpuCreditsPerVcpuHour), memory: text(row.memoryCreditsPerGbHour), storage: text(row.storageCreditsPerGbHour) } }))} empty={<EmptyState title="No price lists" />} />}</Card><Card className="overflow-hidden"><SectionTitle eyebrow="Credits" title="Vouchers" />{vouchers.error ? <div className="p-5"><ErrorCard label="Vouchers" error={vouchers.error} retry={vouchers.reload} /></div> : <DataTable className="rounded-none border-0" loading={vouchers.loading} columns={[{ key: "credits", label: "Credits" },{ key: "status", label: "Status" },{ key: "expires", label: "Expires" }]} rows={voucherRows.map((row, index) => ({ key: idOf(row) || String(index), cells: { credits: text(valueOf(row, "valueCredits", "credits")), status: <StatusBadge tone={statusTone(valueOf(row, "status", "redeemedAt"))}>{row.redeemedAt ? "Redeemed" : titleCase(valueOf(row, "status") ?? "Available")}</StatusBadge>, expires: formatDate(row.expiresAt) } }))} empty={<EmptyState title="No vouchers" />} />}</Card></div></div>
    <Dialog open={voucherOpen} onClose={() => setVoucherOpen(false)} title="Create voucher" description="Create a credit voucher through the platform billing API." actions={<><Button onClick={() => setVoucherOpen(false)}>Cancel</Button><Button variant="primary" type="submit" form="voucher-form">Create voucher</Button></>}><form id="voucher-form" onSubmit={(event) => void createVoucher(event)}><Field label="Credit value" required><NumberInput min="1" value={credits} onChange={(e) => setCredits(e.target.value)} /></Field></form></Dialog>
  </main>;
}

export function PlatformSecurityPage() {
  const tenants = useApi<unknown>("/api/tenants", []); const tenantRows = items<Row>(tenants.data); const [tenantId, setTenantId] = useState(""); const [notice, setNotice] = useState<Notice>();
  const operations = useApi<unknown>(tenantId ? `/api/tenants/${encodeURIComponent(tenantId)}/operations` : undefined, []); const audit = useApi<unknown>(tenantId ? `/api/tenants/${encodeURIComponent(tenantId)}/audit-log?limit=50` : undefined, []);
  const operationRows = items<Row>(operations.data); const auditRows = items<Row>(audit.data);
  async function retry(row: Row) { const id = idOf(row); if (!id || !tenantId) return; try { await apiRequest(`/api/tenants/${encodeURIComponent(tenantId)}/operations/${encodeURIComponent(id)}/retry`, { method: "POST" }); await operations.reload(); setNotice({ tone: "success", message: "Operation retry requested." }); } catch (error) { setNotice({ tone: "danger", message: `Retry failed: ${readableError(error)}` }); } }
  return <main>
    <PageHeader eyebrow="Platform Admin" title="Security & operations" description="Tenant-scoped operations and audit diagnostics. The backend does not expose a platform-global event feed." />
    <Callout title="Choose a tenant to inspect real audit and operation data">Global audit, security-event and operation endpoints are not available. This page intentionally uses tenant APIs instead of synthesizing a platform-wide feed.</Callout>
    <div className="mt-6"><NoticeCallout notice={notice} /></div>
    <Card className="mt-6 overflow-hidden"><SectionTitle eyebrow="Scope" title="Tenant diagnostics" /><div className="p-5"><Field label="Tenant"><Select value={tenantId} onChange={(e) => setTenantId(e.target.value)}><option value="">Select tenant</option>{tenantRows.map((row) => <option key={idOf(row)} value={idOf(row)}>{text(valueOf(row, "displayName", "name"), "Unnamed tenant")}</option>)}</Select></Field></div></Card>
    {tenantId ? <div className="mt-6 grid gap-6 xl:grid-cols-2"><Card className="overflow-hidden"><SectionTitle eyebrow="Runtime" title="Operations" action={<LinkButton className="h-8 px-3 text-xs" href={tenantHref(tenantId, "operations")}>Open full view</LinkButton>} />{operations.error ? <div className="p-5"><ErrorCard label="Operations" error={operations.error} retry={operations.reload} /></div> : <DataTable className="rounded-none border-0" loading={operations.loading} columns={[{ key: "operation", label: "Operation" },{ key: "status", label: "Status" },{ key: "updated", label: "Updated" },{ key: "actions", label: "Actions" }]} rows={operationRows.slice(0,20).map((row) => { const state = text(row.status, "Unknown"); return { key: idOf(row) || text(row.type), cells: { operation: titleCase(valueOf(row, "type", "operationType", "name")), status: <StatusBadge tone={statusTone(state)}>{state}</StatusBadge>, updated: formatDate(valueOf(row, "updatedAt", "createdAt")), actions: state.toLowerCase().includes("fail") ? <Button size="sm" onClick={() => void retry(row)}>Retry</Button> : "—" } }; })} empty={<EmptyState icon={<ActivityIcon />} title="No operations" />} />}</Card><Card className="overflow-hidden"><SectionTitle eyebrow="Security" title="Audit events" action={<LinkButton className="h-8 px-3 text-xs" href={tenantHref(tenantId, "audit")}>Open full view</LinkButton>} />{audit.error ? <div className="p-5"><ErrorCard label="Audit log" error={audit.error} retry={audit.reload} /></div> : <DataTable className="rounded-none border-0" loading={audit.loading} columns={[{ key: "action", label: "Action" },{ key: "actor", label: "Actor" },{ key: "result", label: "Result" },{ key: "time", label: "Time" }]} rows={auditRows.slice(0,20).map((row, index) => ({ key: idOf(row) || `${text(row.action)}-${index}`, cells: { action: titleCase(row.action), actor: text(valueOf(row, "actorName", "actor"), "System"), result: <StatusBadge tone={statusTone(row.result)}>{titleCase(row.result)}</StatusBadge>, time: formatDate(valueOf(row, "createdAt", "timestamp")) } }))} empty={<EmptyState icon={<LockIcon />} title="No audit events" />} />}</Card></div> : <div className="mt-6"><EmptyState icon={<ActivityIcon />} title="Select a tenant to begin" description="Operations and audit are scoped to a tenant by the backend." /></div>}
  </main>;
}

export function PlatformMaintenancePage() {
  const maintenance = useApi<Row>("/api/platform/maintenance"); const [enabled, setEnabled] = useState(false); const [reason, setReason] = useState(""); const [confirmOpen, setConfirmOpen] = useState(false); const [saving, setSaving] = useState(false); const [notice, setNotice] = useState<Notice>();
  useEffect(() => { if (!maintenance.data) return; setEnabled(bool(maintenance.data.enabled)); setReason(text(maintenance.data.reason, "")); }, [maintenance.data]);
  async function save() { setSaving(true); setNotice(undefined); try { await apiRequest("/api/platform/maintenance", { method: "PATCH", body: { enabled, reason: reason.trim() || null } }); await maintenance.reload(); setConfirmOpen(false); setNotice({ tone: "success", message: "Maintenance state saved." }); } catch (error) { setNotice({ tone: "danger", message: `Maintenance update failed: ${readableError(error)}` }); } finally { setSaving(false); } }
  if (maintenance.loading && !maintenance.data) return <main><PageHeader eyebrow="Platform Admin" title="Maintenance" description="Control platform maintenance state." /><LoadingCard label="maintenance state" /></main>;
  return <main>
    <PageHeader eyebrow="Platform Admin" title="Maintenance" description="Use the platform maintenance API for deliberate service-wide maintenance windows." />
    {maintenance.error ? <ErrorCard label="Maintenance state" error={maintenance.error} retry={maintenance.reload} /> : null}<NoticeCallout notice={notice} />
    <Card className="mt-6 overflow-hidden"><SectionTitle eyebrow="Configuration" title="Maintenance state" description="Changes can affect workload operations across the platform and require confirmation." /><div className="grid gap-6 p-5 lg:grid-cols-[minmax(0,1fr)_300px]"><form className="space-y-5" onSubmit={(event) => { event.preventDefault(); setConfirmOpen(true); }}><label className="flex items-start gap-3 rounded-lg border border-[#D7E0EC] p-4"><input className="mt-1" aria-label="Enabled" type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /><span><strong className="block text-sm text-[#172033]">Enabled</strong><span className="mt-1 block text-xs text-[#718096]">When enabled, runtime operations may be blocked by platform maintenance rules.</span></span></label><Field label="Reason" hint="Explain why maintenance is enabled or why the state is changing."><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field><Button variant={enabled ? "danger" : "primary"} type="submit">Save</Button></form><Card className="bg-[#F8FAFD] p-4"><h3 className="text-sm font-semibold text-[#172033]">Current API state</h3><div className="mt-4"><DetailList columns={1} items={[{ label: "Status", value: <StatusBadge tone={maintenance.data?.enabled ? "warning" : "success"}>{maintenance.data?.enabled ? "Enabled" : "Disabled"}</StatusBadge> },{ label: "Reason", value: text(maintenance.data?.reason, "No reason set") },{ label: "Updated", value: formatDate(valueOf(asRecord(maintenance.data), "updatedAt", "changedAt")) }]} /></div></Card></div></Card>
    <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Confirm maintenance change" description={enabled ? "Enabling maintenance can block platform runtime operations." : "Disabling maintenance re-opens platform runtime operations."} danger={enabled} actions={<><Button onClick={() => setConfirmOpen(false)}>Cancel</Button><Button variant={enabled ? "danger" : "primary"} disabled={saving} onClick={() => void save()}>Confirm maintenance change</Button></>}><p className="text-sm text-[#5B6678]">New state: <strong className="text-[#172033]">{enabled ? "Enabled" : "Disabled"}</strong>{reason.trim() ? <> — {reason.trim()}</> : null}</p></Dialog>
  </main>;
}
