import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../api/client";
import {
  Button,
  Callout,
  Card,
  Checkbox,
  Field,
  LockIcon,
  PageHeader,
  Select,
  SettingsIcon,
  StatusText,
  Toggle,
  UsersIcon,
} from "../components/design-system";
import { idOf, items, text, useApi } from "../hooks/use-api";

type R = Record<string, unknown>;
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

export function TenantSettingsPage({ tenantId }: { tenantId: string }) {
  const root = `/api/tenants/${encodeURIComponent(tenantId)}`;
  const settings = useApi<McpSettings>(`${root}/mcp-settings`);
  const memberships = useApi<unknown>(`${root}/memberships`);
  const [enabled, setEnabled] = useState(false);
  const [accessMode, setAccessMode] = useState<AccessMode>("SelectedMembers");
  const [selected, setSelected] = useState<string[]>([]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();

  useEffect(() => {
    if (!settings.data) return;
    setEnabled(settings.data.enabled === true);
    setAccessMode(settings.data.accessMode === "AllMembers" ? "AllMembers" : "SelectedMembers");
    setSelected(Array.isArray(settings.data.allowedMembershipIds) ? settings.data.allowedMembershipIds : []);
  }, [settings.data]);

  const memberRows = useMemo(
    () => items<R>(memberships.data).filter((member) => text(member.status, "Active") === "Active"),
    [memberships.data],
  );

  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const mcpUrl = origin ? `${origin}/api/tenants/${encodeURIComponent(tenantId)}/mcp` : `/api/tenants/${tenantId}/mcp`;

  function toggleMember(membershipId: string, checked: boolean) {
    setSelected((current) =>
      checked ? [...new Set([...current, membershipId])] : current.filter((id) => id !== membershipId),
    );
  }

  async function save() {
    setWorking(true);
    setError(undefined);
    setSuccess(undefined);
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
      setSuccess("Tenant MCP settings saved.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Tenant MCP settings could not be saved.");
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
      {success ? <div className="mb-4" role="status"><Callout tone="success" title={success} /></div> : null}
      {error || settings.error ? (
        <div className="mb-4">
          <Callout tone="danger" title="Tenant settings unavailable">
            {error ?? (settings.error instanceof Error ? settings.error.message : "The settings request failed.")}
          </Callout>
        </div>
      ) : null}

      <Card id="mcp" className="overflow-hidden">
        <div className="flex items-start gap-3 border-b border-[#E1E7F0] px-5 py-4">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#E7F1FF] text-[#1769E0]"><SettingsIcon size={18} /></span>
          <div>
            <h2 className="font-semibold">Model Context Protocol (MCP)</h2>
            <p className="mt-1 text-sm text-[#5B6678]">Standards-compliant Streamable HTTP MCP for OpenAI/ChatGPT and other MCP clients, using ResourcePortal OAuth and the tenant's existing RBAC.</p>
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
              <p className="mt-1 text-sm text-[#5B6678]">Paste this single server URL into OpenAI/ChatGPT or another MCP host. OAuth discovery, client registration and account linking happen automatically.</p>
            </div>
            {oauth?.openAiReady ? <StatusText tone="success">OpenAI / ChatGPT ready</StatusText> : <StatusText tone="warning">OAuth setup incomplete</StatusText>}
          </div>
        </div>
        <div className="p-5">
          <p className="text-xs font-medium text-[#718096]">MCP server URL</p>
          <code className="mt-1 block break-all rounded-md bg-[#F3F6FA] p-3 text-xs">{mcpUrl}</code>
          <p className="mt-2 text-xs leading-5 text-[#718096]">No metadata URL, Client ID or client secret needs to be copied into the MCP client.</p>
        </div>
        <div className="space-y-3 border-t border-[#E1E7F0] bg-[#F8FAFD] p-5">
          <Callout title="Automatic OAuth account linking">Compatible MCP clients discover ResourcePortal protected-resource metadata and the authorization server from the MCP URL, then use OAuth Authorization Code + PKCE automatically.</Callout>
          {!oauth?.openAiReady ? <Callout tone="warning" title="Platform OAuth bootstrap is incomplete">Automatic linking requires Dynamic Client Registration and PKCE S256. The platform operator should run the current ResourcePortal upgrade or repair; tenant users should not create a manual OAuth client.</Callout> : <Callout tone="success" title="No Client ID or secret required">ResourcePortal prepares ZITADEL Dynamic Client Registration for MCP and publishes standards-compatible OAuth discovery metadata, so clients can register and complete user sign-in automatically.</Callout>}
        </div>
      </Card>
    </main>
  );
}