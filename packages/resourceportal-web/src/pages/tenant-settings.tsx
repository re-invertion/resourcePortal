import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../api/client";
import {
  Button,
  Callout,
  Card,
  Checkbox,
  ConfirmActionButton,
  Field,
  HelpIcon,
  LockIcon,
  PageHeader,
  Select,
  SettingsIcon,
  StatusText,
  Tabs,
  TextInput,
  Toggle,
  UsersIcon,
} from "../components/design-system";
import { idOf, items, text, useApi } from "../hooks/use-api";
import { tenantHref } from "../router/router";
import { toast } from "../components/toast";

type R = Record<string, unknown>;
type ResourceBotSettings = { enabled: boolean; updatedAt?: string | null };
type AccessMode = "AllMembers" | "SelectedMembers";
type McpSettings = {
  enabled: boolean;
  accessMode: AccessMode;
  allowedMembershipIds: string[];
  oauth?: {
    issuer?: string | null;
    scopes?: string[];
    discoveryAvailable?: boolean;
    dynamicClientRegistrationAvailable?: boolean;
    pkceS256Available?: boolean;
    openAiReady?: boolean;
    transport?: string;
    protocol?: string;
  };
};

function memberUser(member: R) {
  return member.user && typeof member.user === "object" ? (member.user as R) : undefined;
}

function memberLabel(member: R) {
  const user = memberUser(member);
  return text(member.displayName, text(user?.displayName, text(member.email, text(user?.email, "Tenant member"))));
}

function memberEmail(member: R) {
  const user = memberUser(member);
  return text(member.email, text(user?.email, ""));
}

export function TenantSettingsPage({ tenantId, section = "resource-bot" }: { tenantId: string; section?: string }) {
  const activeSection = section === "mcp" ? "mcp" : section === "branding" ? "branding" : "resource-bot";
  const root = `/api/tenants/${encodeURIComponent(tenantId)}`;
  const branding = useApi<{ displayName: string; logoDataUrl?: string | null }>(`${root}`);
  const settings = useApi<McpSettings>(`${root}/mcp-settings`);
  const catalog = useApi<{ items: Array<{ name: string; title: string; description: string }> }>(activeSection === "mcp" ? `${root}/mcp-settings/catalog` : undefined);
  const resourceBotSettings = useApi<ResourceBotSettings>(`${root}/resource-bot/settings`);
  const memberships = useApi<unknown>(`${root}/memberships`);
  const [resourceBotEnabled, setResourceBotEnabled] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [accessMode, setAccessMode] = useState<AccessMode>("SelectedMembers");
  const [selected, setSelected] = useState<string[]>([]);
  const [working, setWorking] = useState(false);
  const [tenantDisplayName, setTenantDisplayName] = useState("");
  const [tenantLogo, setTenantLogo] = useState<string | null>(null);
  const [brandingDirty, setBrandingDirty] = useState(false);

  useEffect(() => {
    if (!branding.data || typeof branding.data.displayName !== "string") return;
    setTenantDisplayName(branding.data.displayName);
    setTenantLogo(branding.data.logoDataUrl ?? null);
    setBrandingDirty(false);
  }, [branding.data]);

  function selectLogo(file: File | undefined) {
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 128 * 1024) {
      toast.error("Choose a PNG, JPEG or WebP logo up to 128 KiB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setTenantLogo(reader.result);
        setBrandingDirty(true);
      }
    };
    reader.onerror = () => toast.error("Tenant logo could not be read.");
    reader.readAsDataURL(file);
  }

  async function saveBranding() {
    setWorking(true);
    try {
      await apiRequest(`${root}/branding`, { method: "PATCH", body: {
        displayName: tenantDisplayName.trim(), logoDataUrl: tenantLogo,
      } });
      await branding.reload();
      toast.success("Tenant branding saved.");
    } catch (cause) {
      toast.errorFrom(cause, "Tenant branding could not be saved.");
    } finally {
      setWorking(false);
    }
  }

  useEffect(() => {
    if (!settings.data) return;
    setEnabled(settings.data.enabled === true);
    setAccessMode(settings.data.accessMode === "AllMembers" ? "AllMembers" : "SelectedMembers");
    setSelected(Array.isArray(settings.data.allowedMembershipIds) ? settings.data.allowedMembershipIds : []);
  }, [settings.data]);

  useEffect(() => {
    if (!resourceBotSettings.data) return;
    setResourceBotEnabled(resourceBotSettings.data.enabled !== false);
  }, [resourceBotSettings.data]);

  const memberRows = useMemo(
    () => items<R>(memberships.data).filter((member) => text(member.status, "Active") === "Active"),
    [memberships.data],
  );

  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const tenantMcpTools=(catalog.data?.items??[]).filter(tool=>tool.name.startsWith("resourceportal_")&&!tool.name.startsWith("resourceportal_admin_")&&!tool.name.startsWith("resourceportal_platform_"));
  const mcpUrl = origin ? `${origin}/api/tenants/${encodeURIComponent(tenantId)}/mcp` : `/api/tenants/${tenantId}/mcp`;

  function toggleMember(membershipId: string, checked: boolean) {
    setSelected((current) =>
      checked ? [...new Set([...current, membershipId])] : current.filter((id) => id !== membershipId),
    );
  }

  async function saveResourceBot() {
    setWorking(true);
    try {
      await apiRequest(`${root}/resource-bot/settings`, {
        method: "PATCH",
        body: { enabled: resourceBotEnabled },
      });
      await resourceBotSettings.reload();
      toast.success(resourceBotEnabled ? "ResourceBot enabled for this tenant." : "ResourceBot disabled for this tenant.");
    } catch (cause) {
      toast.errorFrom(cause, "ResourceBot settings could not be saved.");
    } finally {
      setWorking(false);
    }
  }

  async function save() {
    setWorking(true);
    try {
      await apiRequest(`${root}/mcp-settings`, {
        method: "PATCH",
        body: {
          enabled,
          accessMode,
          allowedMembershipIds: accessMode === "SelectedMembers" ? selected : [],
        },
      });
      await settings.reload();
      toast.success("Tenant MCP settings saved.");
    } catch (cause) {
      toast.errorFrom(cause, "Tenant MCP settings could not be saved.");
    } finally {
      setWorking(false);
    }
  }

  const oauth = settings.data?.oauth;
  const noSelectedMembers = enabled && accessMode === "SelectedMembers" && selected.length === 0;

  return (
    <main>
      <PageHeader
        eyebrow="Tenant administration"
        title="Tenant settings"
        description="Tenant-wide features and integration settings controlled by tenant administrators."
      />
      <Tabs label="Settings sections" items={[{ label: "Branding", href: tenantHref(tenantId, "settings", "branding"), active: activeSection === "branding" }, { label: "ResourceBot", href: tenantHref(tenantId, "settings", "resource-bot"), active: activeSection === "resource-bot" }, { label: "MCP", href: tenantHref(tenantId, "settings", "mcp"), active: activeSection === "mcp" }]} />
      {settings.error ? (
        <div className="mb-4">
          <Callout tone="danger" title="Tenant settings unavailable">
            {settings.error instanceof Error ? settings.error.message : "The settings request failed."}
          </Callout>
        </div>
      ) : null}

      {activeSection === "branding" ? <Card className="mb-5 p-5">
        <h2 className="text-lg font-semibold">Tenant branding</h2>
        <p className="mt-1 text-sm text-[#5B6678]">Change the visible tenant name and logo. The internal tenant identifier stays unchanged.</p>
        <div className="mt-5 grid gap-5 sm:grid-cols-[minmax(0,1fr)_auto]">
          <div className="space-y-4">
            <Field label="Visible tenant name" required>
              <TextInput value={tenantDisplayName} maxLength={160} onChange={e => { setTenantDisplayName(e.target.value); setBrandingDirty(true); }} />
            </Field>
            <Field label="Tenant logo" hint="PNG, JPEG or WebP, up to 128 KiB.">
              <input type="file" accept="image/png,image/jpeg,image/webp" aria-label="Upload tenant logo" onChange={e => selectLogo(e.target.files?.[0])} />
            </Field>
            {tenantLogo ? <Button size="sm" onClick={() => { setTenantLogo(null); setBrandingDirty(true); }}>Remove tenant logo</Button> : null}
          </div>
          <div className="flex items-start">
            {tenantLogo ? <img src={tenantLogo} alt="Tenant logo preview" className="h-20 w-20 rounded-xl object-contain" /> :
              <span className="flex h-20 w-20 items-center justify-center rounded-xl bg-[#E7F1FF] text-[#1769E0]">No logo</span>}
          </div>
        </div>
        <div className="mt-5 flex justify-end">
          <ConfirmActionButton triggerVariant="primary" confirmVariant="primary"
            confirmTitle="Confirm tenant branding changes"
            confirmDescription="Apply the visible name and logo to this tenant? The new branding will be shown to its members."
            confirmLabel="Apply tenant branding" disabled={working || !brandingDirty || !tenantDisplayName.trim() || tenantDisplayName.trim().length > 160}
            onConfirm={saveBranding}>Save tenant branding</ConfirmActionButton>
        </div>
      </Card> : null}
      {activeSection === "resource-bot" ? <Card id="resource-bot" className="overflow-hidden">
        <div className="flex items-start gap-3 border-b border-[#E1E7F0] px-5 py-4">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#E7F1FF] text-[#1769E0]"><HelpIcon size={18} /></span>
          <div>
            <h2 className="font-semibold">ResourceBot</h2>
            <p className="mt-1 text-sm text-[#5B6678]">Control the built-in Help-grounded AI assistant for this tenant.</p>
          </div>
        </div>
        <div className="space-y-5 p-5">
          {resourceBotSettings.error ? <Callout tone="danger" title="ResourceBot settings unavailable">
            {resourceBotSettings.error instanceof Error ? resourceBotSettings.error.message : "The ResourceBot settings request failed."}
          </Callout> : null}
          <Toggle
            checked={resourceBotEnabled}
            disabled={resourceBotSettings.loading || working}
            onChange={setResourceBotEnabled}
            label="Enable ResourceBot for this tenant"
            description="Enabled by default. Tenant members can ask questions grounded in ResourcePortal Help. Usage is metered against this tenant's billing account."
          />
          <Callout title="Help only">
            ResourceBot does not receive live access to tenant resources, secrets, deployments or platform administration. It answers from ResourcePortal Help and links back to the relevant Help sections.
          </Callout>
          <div className="flex justify-end">
            <Button variant="primary" disabled={working || resourceBotSettings.loading} onClick={() => void saveResourceBot()}>
              {working ? "Saving…" : "Save ResourceBot settings"}
            </Button>
          </div>
        </div>
      </Card> : <>
      <Card id="mcp" className="overflow-hidden">
        <div className="flex items-start gap-3 border-b border-[#E1E7F0] px-5 py-4">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#E7F1FF] text-[#1769E0]"><SettingsIcon size={18} /></span>
          <div>
            <h2 className="font-semibold">Model Context Protocol (MCP)</h2>
            <p className="mt-1 text-sm text-[#5B6678]">Configure tenant MCP access, authorization and the endpoint exposed to MCP clients.</p>
          </div>
        </div>

        <div className="space-y-6 p-5">
          <Toggle
            checked={enabled}
            disabled={settings.loading || working}
            onChange={setEnabled}
            label="Enable MCP for this tenant"
            description="Disabled by default. When enabled, only permitted active tenant members can authenticate to the tenant MCP endpoint."
          />

          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Who can use MCP" hint="This controls entry to MCP. It does not change ResourcePortal roles or permissions.">
              <Select
                aria-label="MCP access mode"
                value={accessMode}
                disabled={!enabled || working}
                onChange={(event) => setAccessMode(event.target.value as AccessMode)}
              >
                <option value="SelectedMembers">Selected tenant members</option>
                <option value="AllMembers">All active tenant members</option>
              </Select>
            </Field>
            <div className="rounded-lg border border-[#D7E0EC] bg-[#F8FAFD] p-4">
              <div className="flex items-center gap-2"><LockIcon size={16} className="text-[#1769E0]" /><strong className="text-sm">Authorization model</strong></div>
              <p className="mt-2 text-xs leading-5 text-[#5B6678]">MCP is an additional access gate only. Every tool call is executed as the authenticated user and is checked against the same tenant roles and group permissions as Web/API requests.</p>
            </div>
          </div>

          {enabled && accessMode === "SelectedMembers" ? (
            <div className="rounded-lg border border-[#D7E0EC]">
              <div className="flex items-center gap-2 border-b border-[#E1E7F0] px-4 py-3">
                <UsersIcon size={16} className="text-[#1769E0]" />
                <div><strong className="text-sm">Allowed members</strong><p className="text-xs text-[#718096]">Select active tenant memberships that may establish an MCP session.</p></div>
              </div>
              <div className="divide-y divide-[#E1E7F0]">
                {memberships.loading ? <p className="p-4 text-sm text-[#5B6678]">Loading tenant members…</p> : memberRows.map((member) => {
                  const membershipId = idOf(member);
                  return (
                    <label key={membershipId} className="flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-[#F8FAFD]">
                      <Checkbox
                        aria-label={`Allow ${memberLabel(member)} to use MCP`}
                        checked={selected.includes(membershipId)}
                        disabled={working}
                        onChange={(event) => toggleMember(membershipId, event.target.checked)}
                      />
                      <span className="min-w-0 flex-1"><strong className="block truncate text-[13px]">{memberLabel(member)}</strong><span className="block truncate text-xs text-[#718096]">{memberEmail(member)}</span></span>
                      <StatusText tone="success">Active</StatusText>
                    </label>
                  );
                })}
                {!memberships.loading && memberRows.length === 0 ? <p className="p-4 text-sm text-[#5B6678]">No active tenant memberships are available.</p> : null}
              </div>
            </div>
          ) : null}

          {noSelectedMembers ? <Callout tone="warning" title="No member is allowed yet">MCP can be enabled, but no user will be able to use it until at least one active membership is selected.</Callout> : null}

          <div className="flex justify-end"><Button variant="primary" disabled={working || settings.loading} onClick={() => void save()}>{working ? "Saving…" : "Save tenant settings"}</Button></div>
        </div>
      </Card>

      <Card className="mt-6 overflow-hidden">
        <div className="border-b border-[#E1E7F0] px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-semibold">MCP connection</h2>
              <p className="mt-1 text-sm text-[#5B6678]">Server endpoint and OAuth capabilities used by MCP clients.</p>
            </div>
            {oauth?.openAiReady ? <StatusText tone="success">OAuth ready</StatusText> : <StatusText tone="warning">OAuth setup incomplete</StatusText>}
          </div>
        </div>
        <div className="space-y-4 p-5">
          <div>
            <p className="text-xs font-medium text-[#718096]">MCP server URL</p>
            <code className="mt-1 block break-all rounded-md bg-[#F3F6FA] p-3 text-xs">{mcpUrl}</code>
          </div>
          <details><summary className="cursor-pointer text-sm font-medium">Details</summary>
          <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
            <div className="flex justify-between gap-2 py-1"><dt className="text-[#718096]">Transport</dt><dd className="font-medium">{oauth?.transport ?? "Streamable HTTP"}</dd></div>
            <div className="flex justify-between gap-2 py-1"><dt className="text-[#718096]">Protocol</dt><dd className="font-medium">{oauth?.protocol ?? "MCP"}</dd></div>
            <div className="flex justify-between gap-2 py-1"><dt className="text-[#718096]">OAuth discovery</dt><dd className="font-medium">{oauth?.discoveryAvailable ? "Available" : "Unavailable"}</dd></div>
            <div className="flex justify-between gap-2 py-1"><dt className="text-[#718096]">Dynamic client registration / PKCE S256</dt><dd className="font-medium">{oauth?.dynamicClientRegistrationAvailable && oauth?.pkceS256Available ? "Available" : "Unavailable"}</dd></div>
          </dl>
          </details>
          {!oauth?.openAiReady ? <Callout tone="warning" title="OAuth setup incomplete">Dynamic Client Registration and PKCE S256 must be available before compatible MCP clients can complete OAuth authorization. Run the current ResourcePortal upgrade or platform repair.</Callout> : null}
        </div>
      </Card>
      <Card className="mt-6 overflow-hidden"><div className="border-b border-[#E1E7F0] px-5 py-4"><h2 className="font-semibold">Available Tenant MCP tools</h2><p className="mt-1 text-xs text-[#718096]">Current tenant-scoped tool catalog. {tenantMcpTools.length} tools.</p></div>{catalog.loading?<p className="p-5 text-sm">Loading tools…</p>:catalog.error?<p className="p-5 text-sm text-[#B42318]">Tool catalog unavailable.</p>:<div className="max-h-[480px] divide-y divide-[#E1E7F0] overflow-y-auto">{tenantMcpTools.map(tool=><div key={tool.name} className="px-5 py-3"><strong className="block break-all text-[13px]">{tool.name}</strong><p className="mt-1 text-xs text-[#526070]">{tool.description}</p></div>)}</div>}</Card>
      </>}
    </main>
  );
}