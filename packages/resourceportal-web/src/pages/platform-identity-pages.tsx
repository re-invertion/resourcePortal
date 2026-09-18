import { useState, type FormEvent } from "react";
import { apiRequest } from "../api/client";
import { Button, Card, DataTable, Dialog, EmptyState, Field, KeyIcon, LockIcon, MetricCard, PageHeader, Select, StatusBadge, TextInput, UsersIcon, statusTone } from "../components/design-system";
import { formatDate, idOf, items, text, useApi } from "../hooks/use-api";

type Row = Record<string, unknown>;
type IdentityForm = { name: string; protocol: "OIDC" | "SAML"; issuer: string; metadataUrl: string; clientId: string; clientSecret: string; enabled: boolean };
const emptyIdentity: IdentityForm = { name: "", protocol: "OIDC", issuer: "", metadataUrl: "", clientId: "", clientSecret: "", enabled: true };

function titleCase(value: unknown) {
  return text(value, "Unknown").replaceAll("_", " ").replaceAll("-", " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function bool(value: unknown) { return value === true || value === "true"; }
function valueOf(row: Row, ...keys: string[]) { for (const key of keys) if (row[key] !== undefined && row[key] !== null && row[key] !== "") return row[key]; return undefined; }
function message(error: unknown) { return error instanceof Error ? error.message : "The request could not be completed."; }

export function PlatformIdentityProvidersPage() {
  const providers = useApi<unknown>("/api/platform/identity-providers", []);
  const rows = items<Row>(providers.data);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<IdentityForm>(emptyIdentity);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();

  async function createProvider(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setNotice(undefined);
    const body: Row = { name: form.name.trim(), protocol: form.protocol, enabled: form.enabled };
    if (form.protocol === "OIDC") Object.assign(body, { issuer: form.issuer.trim(), clientId: form.clientId.trim(), clientSecret: form.clientSecret, scopes: ["openid", "profile", "email"], usePkce: true });
    else Object.assign(body, { metadataUrl: form.metadataUrl.trim() });
    try {
      await apiRequest("/api/platform/identity-providers", { method: "POST", body });
      await providers.reload(); setOpen(false); setForm(emptyIdentity); setNotice("Identity provider created.");
    } catch (error) { setNotice(`Identity provider creation failed: ${message(error)}`); }
    finally { setBusy(false); }
  }

  async function setEnabled(id: string, enabled: boolean) {
    setBusy(true); setNotice(undefined);
    try {
      await apiRequest(`/api/platform/identity-providers/${encodeURIComponent(id)}`, { method: "PATCH", body: { enabled } });
      await providers.reload(); setNotice(`Identity provider ${enabled ? "enabled" : "disabled"}.`);
    } catch (error) { setNotice(`Identity provider update failed: ${message(error)}`); }
    finally { setBusy(false); }
  }

  return <main>
    <PageHeader eyebrow="Platform Admin" title="Identity providers" description="OIDC and SAML providers configured for platform sign-in." actions={<Button variant="primary" onClick={() => setOpen(true)}>Add identity provider</Button>} />
    {notice ? <div role="status" className="mb-5 rounded-lg border border-[#D7E0EC] bg-white px-4 py-3 text-sm text-[#42526B]">{notice}</div> : null}
    <section className="mb-6 grid gap-4 sm:grid-cols-3" aria-label="Identity provider summary"><MetricCard label="Identity providers" value={String(rows.length)} icon={<UsersIcon />} loading={providers.loading} error={providers.error} /></section>
    <Card className="overflow-hidden"><DataTable className="rounded-none border-0" loading={providers.loading} columns={[{key:"name",label:"Provider"},{key:"protocol",label:"Protocol"},{key:"status",label:"Status"},{key:"source",label:"Issuer / metadata"},{key:"actions",label:"Actions"}]} rows={rows.map((row) => { const id=idOf(row); const enabled=bool(row.enabled); return {key:id||text(row.name),cells:{name:<strong>{text(row.name,"Unnamed provider")}</strong>,protocol:titleCase(row.protocol),status:<StatusBadge tone={enabled?"success":"neutral"}>{enabled?"Enabled":"Disabled"}</StatusBadge>,source:text(valueOf(row,"issuer","metadataUrl"),"—"),actions:id?<Button size="sm" disabled={busy} onClick={() => void setEnabled(id,!enabled)}>{enabled?"Disable":"Enable"}</Button>:"—"}}; })} empty={<EmptyState icon={<UsersIcon />} title="No platform identity providers" description="Add an OIDC or SAML provider when external federation is required." />} /></Card>
    <Dialog open={open} onClose={() => setOpen(false)} title="Add identity provider" description="Create a platform-wide federation provider using the backend configuration API." actions={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" type="submit" form="platform-idp-form" disabled={busy || !form.name.trim()}>Create identity provider</Button></>}>
      <form id="platform-idp-form" className="space-y-4" onSubmit={(event) => void createProvider(event)}><Field label="Name" required><TextInput aria-label="Name" value={form.name} onChange={(e) => setForm({...form,name:e.target.value})}/></Field><Field label="Protocol" required><Select aria-label="Protocol" value={form.protocol} onChange={(e) => setForm({...form,protocol:e.target.value as "OIDC"|"SAML"})}><option value="OIDC">OIDC</option><option value="SAML">SAML</option></Select></Field>{form.protocol==="OIDC"?<><Field label="Issuer URL" required><TextInput aria-label="Issuer URL" type="url" value={form.issuer} onChange={(e)=>setForm({...form,issuer:e.target.value})}/></Field><Field label="Client ID" required><TextInput aria-label="Client ID" value={form.clientId} onChange={(e)=>setForm({...form,clientId:e.target.value})}/></Field><Field label="Client secret" required><TextInput aria-label="Client secret" type="password" value={form.clientSecret} onChange={(e)=>setForm({...form,clientSecret:e.target.value})}/></Field></>:<Field label="Metadata URL" required><TextInput aria-label="Metadata URL" type="url" value={form.metadataUrl} onChange={(e)=>setForm({...form,metadataUrl:e.target.value})}/></Field>}<label className="flex items-center gap-2 text-sm text-[#172033]"><input type="checkbox" checked={form.enabled} onChange={(e)=>setForm({...form,enabled:e.target.checked})}/>Enabled</label></form>
    </Dialog>
  </main>;
}

export function PlatformCredentialsPage() {
  const oauth = useApi<unknown>("/api/platform/oauth-applications", []);
  const identities = useApi<unknown>("/api/platform/service-identities", []);
  const oauthRows = items<Row>(oauth.data); const serviceRows = items<Row>(identities.data);
  return <main>
    <PageHeader eyebrow="Platform Admin" title="Credentials" description="Platform OAuth applications and service identities. Secrets are not displayed after creation or rotation." />
    <section className="mb-6 grid gap-4 sm:grid-cols-2" aria-label="Credentials summary"><MetricCard label="OAuth applications" value={String(oauthRows.length)} icon={<KeyIcon />} loading={oauth.loading} error={oauth.error}/><MetricCard label="Service identities" value={String(serviceRows.length)} icon={<LockIcon />} loading={identities.loading} error={identities.error}/></section>
    <div className="grid gap-6 xl:grid-cols-2"><Card className="overflow-hidden"><DataTable className="rounded-none border-0" loading={oauth.loading} columns={[{key:"name",label:"OAuth application"},{key:"status",label:"Status"},{key:"type",label:"Type"}]} rows={oauthRows.map((row)=>({key:idOf(row)||text(row.name),cells:{name:<strong>{text(valueOf(row,"displayName","name"),"Unnamed application")}</strong>,status:<StatusBadge tone={statusTone(valueOf(row,"status","enabled"))}>{row.enabled===false?"Disabled":titleCase(valueOf(row,"status","enabled"))}</StatusBadge>,type:titleCase(valueOf(row,"type","grantType"))}}))} empty={<EmptyState title="No OAuth applications"/>}/></Card><Card className="overflow-hidden"><DataTable className="rounded-none border-0" loading={identities.loading} columns={[{key:"name",label:"Service identity"},{key:"status",label:"Status"},{key:"created",label:"Created"}]} rows={serviceRows.map((row)=>({key:idOf(row)||text(row.name),cells:{name:<strong>{text(valueOf(row,"displayName","name"),"Unnamed identity")}</strong>,status:<StatusBadge tone={statusTone(valueOf(row,"status","enabled"))}>{row.enabled===false?"Disabled":titleCase(valueOf(row,"status","enabled"))}</StatusBadge>,created:formatDate(row.createdAt)}}))} empty={<EmptyState title="No service identities"/>}/></Card></div>
  </main>;
}
