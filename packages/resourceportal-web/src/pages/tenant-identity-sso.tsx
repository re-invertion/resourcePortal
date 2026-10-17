import { useState } from "react";
import { apiRequest } from "../api/client";
import {
  Button, Callout, Card, ConfirmActionButton, PageHeader, StatusBadge,
} from "../components/design-system";
import { toast } from "../components/toast";
import { AccessTabs } from "../components/tenant-section-tabs";
import { useApi } from "../hooks/use-api";

type Provider = {
  tenantId: string;
  status: string;
  enabled: boolean;
  issuer?: string | null;
  projectId?: string | null;
  lastErrorCode?: string | null;
  grantCount?: number;
  grantsReconciledAt?: string | null;
};
type OidcApp = {
  id: string;
  name: string;
  type: string;
  clientId: string;
  zitadelProjectId?: string | null;
  hasClientSecret: boolean;
  redirectUris?: string[];
  postLogoutRedirectUris?: string[];
};
type Credentials = {
  name?: string;
  clientId?: string;
  clientSecret?: string;
  warning?: string;
  persistenceStatus?: string;
  auditStatus?: string;
};
const empty = { name: "", type: "Web", redirectUri: "", logoutUri: "" };

export function TenantIdentitySsoPage({ tenantId }: { tenantId: string }) {
  const root = `/api/tenants/${encodeURIComponent(tenantId)}`;
  const provider = useApi<Provider>(`${root}/oidc-provider`);
  const applications = useApi<OidcApp[]>(`${root}/oauth-applications`);
  const memberships = useApi<Array<{ id: string; status: string; user?: { displayName?: string; email?: string } }>>(`${root}/memberships`);
  const [busy, setBusy] = useState(false);
  const [applicationForm, setApplicationForm] = useState(empty);
  const [showForm, setShowForm] = useState(false);
  const [credentials, setCredentials] = useState<Credentials>();
  const [editing, setEditing] = useState<OidcApp | null>(null);
  const [editName, setEditName] = useState("");
  const [editRedirectUri, setEditRedirectUri] = useState("");
  const [editLogoutUri, setEditLogoutUri] = useState("");
  const info = provider.data;
  const apps = Array.isArray(applications.data) ? applications.data : [];
  const ready = info?.enabled === true && info.status === "Active";
  const metadata = info?.issuer
    ? `${info.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`
    : undefined;

  async function operation(label: string, path: string, method: "POST" | "DELETE" = "POST") {
    setBusy(true);
    try {
      await apiRequest(path, { method });
      await Promise.all([provider.reload(), applications.reload()]);
      toast.success(label);
    } catch (error) {
      toast.errorFrom(error, "Identity operation failed.");
    } finally {
      setBusy(false);
    }
  }

  async function createApplication() {
    setBusy(true);
    try {
      const result = await apiRequest<OidcApp & Credentials>(`${root}/oauth-applications`, {
        method: "POST",
        body: {
          name: applicationForm.name.trim(),
          type: applicationForm.type,
          redirectUris: applicationForm.redirectUri.split(/[\n,]+/).map(v => v.trim()).filter(Boolean),
          postLogoutRedirectUris: applicationForm.logoutUri.split(/[\n,]+/).map(v => v.trim()).filter(Boolean),
        },
      });
      setCredentials({ name: result.name, clientId: result.clientId, clientSecret: result.clientSecret });
      setApplicationForm(empty);
      setShowForm(false);
      await applications.reload();
      toast.success("OIDC application created.");
    } catch (error) {
      toast.errorFrom(error, "OIDC application creation failed.");
    } finally {
      setBusy(false);
    }
  }

  function editApplication(app: OidcApp) {
    setEditing(app);
    setEditName(app.name);
    setEditRedirectUri((app.redirectUris ?? []).join("\n"));
    setEditLogoutUri((app.postLogoutRedirectUris ?? []).join("\n"));
  }

  async function saveApplication() {
    if (!editing) return;
    setBusy(true);
    try {
      await apiRequest(`${root}/oauth-applications/${encodeURIComponent(editing.id)}`, {
        method: "PATCH",
        body: {
          name: editName.trim(),
          redirectUris: editRedirectUri.split(/[\n,]+/).map(value => value.trim()).filter(Boolean),
          postLogoutRedirectUris: editLogoutUri.split(/[\n,]+/).map(value => value.trim()).filter(Boolean),
        },
      });
      setEditing(null);
      await applications.reload();
      toast.success("OIDC client updated.");
    } catch (error) {
      toast.errorFrom(error, "OIDC application update failed.");
    } finally {
      setBusy(false);
    }
  }

  async function rotate(app: OidcApp) {
    setBusy(true);
    try {
      const result = await apiRequest<Credentials>(
        `${root}/oauth-applications/${encodeURIComponent(app.id)}/rotate-credentials`,
        { method: "POST" },
      );
      setCredentials({ ...result, name: app.name });
      await applications.reload();
      toast.success("Credentials rotated.");
    } catch (error) {
      toast.errorFrom(error, "Credential rotation failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <PageHeader
        eyebrow="Tenant identity"
        title="Identity & SSO"
        description="Manage the identity provider your tenant offers to its own applications."
      />
      <AccessTabs tenantId={tenantId} active="identity-sso" />

      <div className="space-y-5">
        <Card className="space-y-4 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">Tenant OIDC provider</h2>
              <p className="text-sm text-[#5B6678]">
                This is outbound single sign-on for tenant applications, not an external sign-in method for RP.
              </p>
            </div>
            <StatusBadge tone={ready ? "success" : info?.status === "ReconciliationFailed" || info?.status === "ProvisioningFailed" ? "danger" : "warning"}>
              {provider.loading ? "Loading" : info?.status ?? "Unavailable"}
            </StatusBadge>
          </div>
          {provider.error ? <Callout tone="danger" title="Unable to read tenant identity status">Check permissions or retry the request.</Callout> : null}
          {!ready ? <Callout tone="warning" title="Identity provider not active">
            No tenant OIDC application can be created until security checks and grant reconciliation pass.
            Platform rollout approval and real ZITADEL integration testing are additionally required.
          </Callout> : null}
          {info?.lastErrorCode ? <p role="alert" className="text-sm text-[#A92317]">Provisioning error: {info.lastErrorCode}</p> : null}
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div><dt className="text-[#5B6678]">Provider status</dt><dd className="font-medium">{info?.status ?? "—"}</dd></div>
            <div><dt className="text-[#5B6678]">Tracked grants</dt><dd className="font-medium">{info?.grantCount ?? "—"}</dd></div>
            <div><dt className="text-[#5B6678]">Last grant reconciliation</dt><dd>{info?.grantsReconciledAt ? new Date(info.grantsReconciledAt).toLocaleString() : "Never"}</dd></div>
            <div><dt className="text-[#5B6678]">Tenant project</dt><dd className="break-all font-mono text-xs">{info?.projectId ?? "Not provisioned"}</dd></div>
          </dl>
          {info?.issuer ? <div className="rounded-md bg-[#F6F8FC] p-3 text-sm">
            <p className="font-medium">OIDC issuer (shared ZITADEL issuer)</p>
            <p className="mt-1 break-all font-mono text-xs">{info.issuer}</p>
            {metadata ? <a className="mt-2 inline-block break-all text-[#1769E0] underline" href={metadata} target="_blank" rel="noreferrer">Open OIDC discovery</a> : null}
            <p className="mt-2 text-xs text-[#5B6678]">Your tenant has an isolated project and grants, not a separate issuer domain. Relying parties must validate the token audience and project roles.</p>
          </div> : null}
          <div className="rounded-md border border-[#D7E0EC] p-3 text-sm">
            <h3 className="font-medium">Tenant authorization</h3>
            <p className="mt-1 text-xs text-[#5B6678]">
              A verified active RP membership is required to receive the ZITADEL project role
              <code> rp.tenant.member</code>. The allowed scopes and consent flow are enforced by
              ZITADEL, not configured independently in this panel.
            </p>
            <p className="mt-2 text-xs text-[#5B6678]">
              Active RP members: {Array.isArray(memberships.data) ? memberships.data.filter(member => member.status === "Active").length : "—"}.
              Upstream role grants tracked: {info?.grantCount ?? "—"}.
            </p>
            <a className="mt-2 inline-block text-[#1769E0] underline" href={`/tenants/${encodeURIComponent(tenantId)}/activity/audit`}>View tenant audit</a>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy || provider.loading || info?.status !== "NotProvisioned"} onClick={() => void operation("Provisioning requested.", `${root}/oidc-provider/provision`)}>Provision provider</Button>
            <Button disabled={busy || !info?.projectId} onClick={() => void operation("Grants reconciled.", `${root}/oidc-provider/reconcile-grants`)}>Reconcile grants</Button>
            <ConfirmActionButton
              disabled={busy || info?.status !== "GrantsReconciled"}
              confirmTitle="Activate tenant OIDC provider?"
              confirmDescription="Only proceed after a platform operator has validated OIDC token and tenant isolation tests."
              confirmLabel="Request activation"
              confirmVariant="primary"
              onConfirm={() => operation("Activation completed.", `${root}/oidc-provider/activate`)}
            >Activate</ConfirmActionButton>
            <ConfirmActionButton disabled={busy || !info?.projectId} confirmTitle="Disable tenant SSO?" confirmDescription="Tenant sign-in to applications will stop; upstream user grants will be revoked." confirmLabel="Disable provider" onConfirm={() => operation("Provider disabled.", `${root}/oidc-provider/disable`)}>Disable</ConfirmActionButton>
            <ConfirmActionButton disabled={busy || !info?.projectId} confirmTitle="Delete tenant identity project?" confirmDescription="All OIDC applications must be deleted first. The action is irreversible." confirmLabel="Delete provider" onConfirm={() => operation("Provider deleted.", `${root}/oidc-provider`, "DELETE")}>Delete provider</ConfirmActionButton>
          </div>
        </Card>

        <Card className="space-y-4 p-5">
          <div className="flex flex-wrap justify-between gap-3">
            <div><h2 className="text-lg font-semibold">OIDC applications</h2>
              <p className="text-sm text-[#5B6678]">Register a client for your tenant's SSO integration.</p>
            </div>
            <Button variant="primary" disabled={busy || !ready} onClick={() => setShowForm(value => !value)}>
              {showForm ? "Cancel" : "Create application"}
            </Button>
          </div>
          {applications.error ? <Callout tone="danger" title="Unable to load applications">Retry after verifying tenant permissions.</Callout> : null}
          {showForm ? <div className="grid gap-3 rounded-lg border border-[#D7E0EC] p-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">Application name
              <input className="rounded-md border px-3 py-2" value={applicationForm.name} onChange={e => setApplicationForm({ ...applicationForm, name: e.target.value })} maxLength={128} />
            </label>
            <label className="flex flex-col gap-1 text-sm">Application type
              <select className="rounded-md border px-3 py-2" value={applicationForm.type} onChange={e => setApplicationForm({ ...applicationForm, type: e.target.value })}>
                <option>Web</option><option>SPA</option><option>Native</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm sm:col-span-2">Redirect URI (one per line)
              <textarea className="min-h-20 rounded-md border px-3 py-2" value={applicationForm.redirectUri} onChange={e => setApplicationForm({ ...applicationForm, redirectUri: e.target.value })} placeholder="https://app.example.com/oidc/callback" />
            </label>
            <label className="flex flex-col gap-1 text-sm sm:col-span-2">Post-logout redirect URI (optional)
              <input className="rounded-md border px-3 py-2" value={applicationForm.logoutUri} onChange={e => setApplicationForm({ ...applicationForm, logoutUri: e.target.value })} placeholder="https://app.example.com/" />
            </label>
            <div className="sm:col-span-2"><Button variant="primary" disabled={busy || !applicationForm.name.trim() || !applicationForm.redirectUri.trim()} onClick={() => void createApplication()}>Register client</Button></div>
          </div> : null}

          {editing ? <div className="space-y-3 rounded-lg border border-[#D7E0EC] p-4">
            <h3 className="font-semibold">Edit {editing.name}</h3>
            <label className="block text-sm">Name
              <input className="mt-1 w-full rounded-md border px-3 py-2" value={editName} onChange={event => setEditName(event.target.value)} maxLength={128} />
            </label>
            <label className="block text-sm">Allowed redirect URIs
              <textarea className="mt-1 min-h-20 w-full rounded-md border px-3 py-2" value={editRedirectUri} onChange={event => setEditRedirectUri(event.target.value)} />
            </label>
            <label className="block text-sm">Post-logout redirect URIs
              <textarea className="mt-1 min-h-20 w-full rounded-md border px-3 py-2" value={editLogoutUri} onChange={event => setEditLogoutUri(event.target.value)} />
            </label>
            <div className="flex gap-2">
              <Button variant="primary" disabled={busy || !editName.trim() || !editRedirectUri.trim()} onClick={() => void saveApplication()}>Save changes</Button>
              <Button disabled={busy} onClick={() => setEditing(null)}>Cancel</Button>
            </div>
          </div> : null}

          {credentials ? <div role="status" className="rounded-md border border-[#A9D6B6] bg-[#F3FBF7] p-4">
            <h3 className="font-semibold">Save credentials now — shown once</h3>
            <p className="text-xs text-[#5B6678]">They are held only in this page state, not browser storage. Do not share them or include them in logs.</p>
            <p className="mt-2 text-sm">Client ID: <code className="break-all">{credentials.clientId}</code></p>
            {credentials.clientSecret ? <p className="mt-2 text-sm">Client secret: <code className="break-all">{credentials.clientSecret}</code></p> : null}
            {credentials.warning ? <p className="mt-2 text-sm text-[#A92317]">{credentials.warning}</p> : null}
            <Button className="mt-3" size="sm" onClick={() => setCredentials(undefined)}>I saved these credentials</Button>
          </div> : null}

          {applications.loading ? <p className="text-sm text-[#5B6678]">Loading clients…</p>
          : apps.length === 0 ? <p className="text-sm text-[#5B6678]">No OIDC applications registered.</p>
          : <div className="space-y-3">{apps.map(app => (
            <div key={app.id} className="rounded-lg border border-[#D7E0EC] p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div><h3 className="font-semibold">{app.name}</h3><p className="text-xs text-[#5B6678]">{app.type} · Client ID: <code className="break-all">{app.clientId}</code></p></div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" disabled={busy} onClick={() => editApplication(app)}>Edit</Button>
                  {app.hasClientSecret ? <ConfirmActionButton disabled={busy} size="sm" triggerVariant="secondary" confirmVariant="primary" confirmTitle={`Rotate secret for ${app.name}?`} confirmDescription="The old secret will stop working. Update every relying party immediately." confirmLabel="Rotate" onConfirm={() => rotate(app)}>Rotate secret</ConfirmActionButton> : null}
                  <ConfirmActionButton disabled={busy} size="sm" triggerVariant="danger" confirmTitle={`Delete ${app.name}?`} confirmDescription="Existing SSO integrations using this client will stop working." confirmLabel="Delete client" onConfirm={() => operation("Application deleted.", `${root}/oauth-applications/${encodeURIComponent(app.id)}`, "DELETE")}>Delete</ConfirmActionButton>
                </div>
              </div>
              {!app.zitadelProjectId ? <p role="alert" className="mt-2 text-xs text-[#9A6700]">Legacy global-project client. Migrate it before tenant OIDC activation.</p> : null}
            </div>
          ))}</div>}
        </Card>
      </div>
    </main>
  );
}
