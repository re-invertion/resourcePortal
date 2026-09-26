import { useEffect, useState, type FormEvent } from "react";
import { apiRequest } from "../api/client";
import {
  Button,
  Callout,
  Card,
  DetailList,
  Field,
  GlobeIcon,
  PageHeader,
  StatusBadge,
  TextInput,
  statusTone,
} from "../components/design-system";
import { formatDate, text, useApi } from "../hooks/use-api";
import { toast } from "../components/toast";

type DnsState = {
  provider?: string;
  enabled?: boolean;
  available?: boolean;
  configured?: boolean;
  tokenConfigured?: boolean;
  tenantOauthConfigured?: boolean;
  oauthClientId?: string | null;
  oauthClientSecretConfigured?: boolean;
  oauthRedirectUri?: string;
  zoneId?: string | null;
  zoneName?: string | null;
  baseDomain?: string;
  targetHostname?: string;
  lastValidatedAt?: string | null;
  lastError?: string | null;
  updatedAt?: string | null;
};

export function PlatformDnsPage() {
  const dns = useApi<DnsState>("/api/platform/dns");
  const [enabled, setEnabled] = useState(false);
  const [zoneId, setZoneId] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [oauthClientId, setOauthClientId] = useState("");
  const [oauthClientSecret, setOauthClientSecret] = useState("");
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (!dns.data) return;
    setEnabled(dns.data.enabled === true);
    setZoneId(text(dns.data.zoneId, ""));
    setApiToken("");
    setOauthClientId(text(dns.data.oauthClientId, ""));
    setOauthClientSecret("");
  }, [dns.data]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setWorking(true);
    try {
      await apiRequest("/api/platform/dns", {
        method: "PATCH",
        body: {
          enabled,
          zoneId: zoneId.trim() || undefined,
          apiToken: apiToken.trim() || undefined,
          oauthClientId: oauthClientId.trim() || undefined,
          oauthClientSecret: oauthClientSecret.trim() || undefined,
        },
      });
      await dns.reload();
      setApiToken("");
      setOauthClientSecret("");
      toast.success(enabled ? "Cloudflare DNS connected and managed domains enabled." : "DNS configuration saved.");
    } catch (error) {
      toast.errorFrom(error, "DNS configuration failed.");
    } finally {
      setWorking(false);
    }
  }

  async function validate() {
    setWorking(true);
    try {
      await apiRequest("/api/platform/dns/validate", { method: "POST" });
      await dns.reload();
      toast.success("Cloudflare token, zone access and DNS write/delete permissions were validated.");
    } catch (error) {
      toast.errorFrom(error, "Cloudflare validation failed.");
    } finally {
      setWorking(false);
    }
  }

  const stateLabel = dns.data?.available ? "Ready" : dns.data?.enabled ? "Unavailable" : "Disabled";

  return <main>
    <PageHeader eyebrow="Platform Admin" title="DNS & Domains" description="Connect ResourcePortal to Cloudflare and control whether tenants may use managed ResourcePortal domains." />
    {dns.error ? <Callout tone="danger" title="DNS configuration unavailable">{dns.error instanceof Error ? dns.error.message : "The platform DNS API could not be loaded."}</Callout> : null}
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,.85fr)]">
      <Card className="overflow-hidden">
        <div className="border-b border-[#E1E7F0] px-5 py-4"><div className="flex items-center gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#E7F1FF] text-[#1769E0]"><GlobeIcon size={19}/></span><div><h2 className="font-semibold text-[#172033]">Cloudflare managed DNS</h2><p className="mt-0.5 text-xs text-[#718096]">The API token is encrypted at rest and is never returned to the browser.</p></div></div></div>
        <form className="space-y-5 p-5" onSubmit={(event)=>void save(event)}>
          <label className="flex items-start gap-3 rounded-lg border border-[#D7E0EC] p-4"><input className="mt-1" aria-label="Enable managed ResourcePortal domains" type="checkbox" checked={enabled} onChange={event=>setEnabled(event.target.checked)}/><span><strong className="block text-sm text-[#172033]">Enable managed ResourcePortal domains</strong><span className="mt-1 block text-xs leading-5 text-[#718096]">Tenants can select Managed ResourcePortal domain only after this integration is configured, validated and enabled.</span></span></label>
          <Field label="Cloudflare Zone ID" required hint="Use the zone that contains the ResourcePortal managed domain."><TextInput value={zoneId} onChange={event=>setZoneId(event.target.value)} placeholder="32-character zone ID" autoComplete="off" /></Field>
          <Field label="Cloudflare API token" hint={dns.data?.tokenConfigured ? "A token is already configured. Leave blank to keep it." : "Required. Use a scoped token with Zone:Read and DNS:Edit for this zone."}><TextInput type="password" value={apiToken} onChange={event=>setApiToken(event.target.value)} placeholder={dns.data?.tokenConfigured ? "Configured — enter only to rotate" : "Cloudflare API token"} autoComplete="new-password" /></Field>
          <Callout title="Scoped permissions only">Create a Cloudflare API token restricted to the selected zone. ResourcePortal validates the token and performs a temporary DNS write/delete probe before enabling managed domains.</Callout>
          <div className="border-t border-[#E1E7F0] pt-5">
            <h3 className="text-sm font-semibold text-[#172033]">Tenant Cloudflare OAuth</h3>
            <p className="mt-1 text-xs leading-5 text-[#718096]">Optional. Configure a Cloudflare OAuth client so tenant users can authorize their own Cloudflare account when adding a custom root domain.</p>
          </div>
          <Field label="OAuth Client ID" hint="Client ID from Cloudflare → Manage Account → OAuth clients."><TextInput value={oauthClientId} onChange={event=>setOauthClientId(event.target.value)} placeholder="Cloudflare OAuth client ID" autoComplete="off" /></Field>
          <Field label="OAuth Client secret" hint={dns.data?.oauthClientSecretConfigured ? "A client secret is already configured. Leave blank to keep it." : "Stored encrypted. Required before tenant Cloudflare authorization can be used."}><TextInput type="password" value={oauthClientSecret} onChange={event=>setOauthClientSecret(event.target.value)} placeholder={dns.data?.oauthClientSecretConfigured ? "Configured — enter only to rotate" : "Cloudflare OAuth client secret"} autoComplete="new-password" /></Field>
          <div className="rounded-lg border border-[#D7E0EC] bg-[#F8FAFD] p-4"><p className="text-xs font-medium text-[#172033]">OAuth redirect URI</p><code className="mt-1 block break-all text-xs text-[#5B6678]">{text(dns.data?.oauthRedirectUri,"Save once to display redirect URI")}</code><p className="mt-2 text-xs leading-5 text-[#718096]">Register this exact URI in Cloudflare. Configure <code>zone.read</code> and <code>dns.write</code>, with Authorization Code and Refresh Token grants and <code>client_secret_basic</code> token authentication. Cloudflare adds <code>offline_access</code> for refresh-enabled clients. Promote the OAuth client to <strong>Public</strong> if tenant users outside the owner Cloudflare account must authorize it.</p></div>
          <div className="flex flex-wrap gap-2"><Button variant="primary" type="submit" disabled={working}>{working?"Saving…":"Save configuration"}</Button><Button type="button" disabled={working||!dns.data?.configured} onClick={()=>void validate()}>Validate connection</Button></div>
        </form>
      </Card>
      <div className="space-y-6">
        <Card className="p-5"><div className="mb-4 flex items-center justify-between gap-3"><h2 className="font-semibold text-[#172033]">Integration state</h2><StatusBadge tone={statusTone(stateLabel)}>{stateLabel}</StatusBadge></div><DetailList columns={1} items={[
          {label:"Provider",value:text(dns.data?.provider,"Cloudflare")},
          {label:"Managed RP domain",value:text(dns.data?.baseDomain,"—")},
          {label:"DNS target",value:text(dns.data?.targetHostname,"—")},
          {label:"Cloudflare zone",value:text(dns.data?.zoneName,text(dns.data?.zoneId,"Not configured"))},
          {label:"API token",value:dns.data?.tokenConfigured?"Configured":"Not configured"},
          {label:"Tenant OAuth",value:dns.data?.tenantOauthConfigured?"Configured":"Not configured"},
          {label:"Last validated",value:formatDate(dns.data?.lastValidatedAt)},
        ]}/></Card>
        {dns.data?.lastError ? <Callout tone="danger" title="Last Cloudflare error">{dns.data.lastError}</Callout> : <Callout tone="success" title="Managed DNS is isolated from custom domains">Custom tenant domains keep their existing ownership verification flow. Cloudflare automation applies only to ResourcePortal-managed hostnames.</Callout>}
      </div>
    </div>
  </main>;
}
