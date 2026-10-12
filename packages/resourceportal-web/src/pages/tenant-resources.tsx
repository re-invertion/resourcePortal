import { useMemo, useState } from "react";
import { apiRequest } from "../api/client";
import { BillingUsageCharts, billingUsageBucket, billingUsageRangeFrom, type BillingUsageRange } from "../components/billing-usage-charts";
import { ActivityIcon, BillingIcon, Button, Card, CpuIcon, DataTable, EmptyState, Field, GlobeIcon, GridIcon, KeyIcon, LinkButton, MemoryIcon, NetworkIcon, PageHeader, RegistryIcon, ServerIcon, StatusBadge, StatusText, Tabs, TextInput, UsersIcon, VolumeIcon, statusTone } from "../components/design-system";
import { toast } from "../components/toast";
import { formatCreditAmount, formatPlnAmount, quotaBytesDisplay, quotaDisplay } from "../lib/billing-display";
import { AccessTabs } from "../components/tenant-section-tabs";
import { formatBytes, formatDate, idOf, items, text, useApi } from "../hooks/use-api";
import { tenantHref } from "../router/router";
import { auditActionDetail, auditActionLabel, auditGroupedCount, auditTimestampValue, isGroupedBillingUsage } from "../lib/audit-display";

type R = Record<string, unknown>;

function BillingMetricCard({
  icon,
  label,
  value,
  detail,
  badge,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  detail?: React.ReactNode;
  badge?: React.ReactNode;
}) {
  return <Card className="min-h-[182px] p-5">
    <div className="flex h-10 items-start justify-between gap-3">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#E7F1FF] text-[#1769E0]">
        {icon}
      </span>
      {badge ? <div className="shrink-0">{badge}</div> : null}
    </div>
    <div className="mt-5 min-w-0">
      <p className="text-xs font-medium text-[#718096]">{label}</p>
      <strong className="mt-1.5 block break-words text-2xl font-semibold tracking-[-0.015em] text-[#172033]">{value}</strong>
      {detail ? <span className="mt-1 block truncate text-xs text-[#718096]">{detail}</span> : null}
    </div>
  </Card>;
}

function ResourceSummary({ title, description, href, count, icon, loading, error }: { title:string; description:string; href:string; count:number; icon:React.ReactNode; loading:boolean; error?:unknown }) {
  return <a href={href} className="rounded-lg border border-[#D7E0EC] bg-white p-5 transition hover:border-[#AFC7E8] hover:shadow-[0_4px_16px_rgba(36,74,120,.06)]"><div className="flex items-start gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#E7F1FF] text-[#1769E0]">{icon}</span><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-3"><h2 className="font-semibold">{title}</h2><strong className="text-lg">{loading?"—":error?"!":count}</strong></div><p className="mt-1 text-sm leading-5 text-[#5B6678]">{description}</p></div></div></a>;
}

export function TenantStoragePage({tenantId}:{tenantId:string}) {
  const root=`/api/tenants/${encodeURIComponent(tenantId)}`;
  const volumes=useApi<unknown>(`${root}/volumes`);
  const registries=useApi<unknown>(`${root}/registries`);
  const volumeRows=items<R>(volumes.data);
  const registryRows=items<R>(registries.data);
  return <main>
    <PageHeader eyebrow="Tenant resources" title="Storage" description="Persistent volumes and container image registries for this tenant."/>
    <Tabs label="Storage sections" items={[
      {label:"Overview",href:tenantHref(tenantId,"storage"),active:true},
      {label:"Volumes",href:tenantHref(tenantId,"volumes")},
      {label:"Registries",href:tenantHref(tenantId,"registries")},
    ]}/>
    <div className="grid gap-4 sm:grid-cols-2">
      <ResourceSummary title="Volumes" description="Persistent storage allocated to application workloads." href={tenantHref(tenantId,"volumes")} count={volumeRows.length} icon={<VolumeIcon/>} loading={volumes.loading} error={volumes.error}/>
      <ResourceSummary title="Registries" description="Private and public container image sources." href={tenantHref(tenantId,"registries")} count={registryRows.length} icon={<RegistryIcon/>} loading={registries.loading} error={registries.error}/>
    </div>
    <div className="mt-6 grid gap-6 xl:grid-cols-2">
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-[#E1E7F0] px-5 py-4"><div><h2 className="font-semibold">Volumes</h2><p className="mt-0.5 text-xs text-[#718096]">Durable data attached to applications.</p></div><LinkButton className="h-8 px-3 text-xs" href={tenantHref(tenantId,"volumes")}>Manage</LinkButton></div>
        <DataTable embedded loading={volumes.loading} columns={[{key:"name",label:"Volume"},{key:"size",label:"Size"},{key:"usage",label:"Used"}]} rows={volumeRows.slice(0,6).map(v=>({key:idOf(v),cells:{name:<strong>{text(v.name)}</strong>,size:formatBytes(v.sizeBytes),usage:formatBytes(v.usedSizeBytes)}}))} empty={<EmptyState icon={<VolumeIcon/>} title="No volumes" description="Create a persistent volume when an application needs durable storage."/>}/>
      </Card>
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-[#E1E7F0] px-5 py-4"><div><h2 className="font-semibold">Registries</h2><p className="mt-0.5 text-xs text-[#718096]">Image sources available to tenant applications.</p></div><LinkButton className="h-8 px-3 text-xs" href={tenantHref(tenantId,"registries")}>Manage</LinkButton></div>
        <DataTable embedded loading={registries.loading} columns={[{key:"name",label:"Registry"},{key:"host",label:"Host"},{key:"status",label:"Status"}]} rows={registryRows.slice(0,6).map(r=>({key:idOf(r),cells:{name:<strong>{text(r.name,"Registry")}</strong>,host:text(r.host,text(r.server,"—")),status:<StatusText tone={statusTone(r.status)}>{text(r.status,"Configured")}</StatusText>}}))} empty={<EmptyState icon={<RegistryIcon/>} title="No registries" description="Add a registry when an application image is not pulled from the default public source."/>}/>
      </Card>
    </div>
  </main>;
}

// Compatibility for old imports while /storage-networking redirects to the Storage view.
export const TenantStorageNetworking = TenantStoragePage;

export function TenantAccess({tenantId}:{tenantId:string}) {
  const root=`/api/tenants/${encodeURIComponent(tenantId)}`; const memberships=useApi<unknown>(`${root}/memberships`); const invitations=useApi<unknown>(`${root}/invitations`); const roles=useApi<unknown>(`${root}/roles`); const groups=useApi<unknown>(`${root}/groups`); const idps=useApi<unknown>(`${root}/identity-providers`); const oauth=useApi<unknown>(`${root}/oauth-applications`); const identities=useApi<unknown>(`${root}/service-identities`);
  const memberRows=items<R>(memberships.data); const inviteRows=items<R>(invitations.data); const roleRows=items<R>(roles.data); const groupRows=items<R>(groups.data); const idpRows=items<R>(idps.data); const oauthRows=items<R>(oauth.data); const identityRows=items<R>(identities.data);
  return <main><PageHeader eyebrow="Tenant security" title="Access" description="People, roles, groups, identity providers and machine identities for this tenant." actions={<div className="flex flex-wrap gap-2"><LinkButton variant="primary" href={tenantHref(tenantId,"administration","invite")}>Invite user</LinkButton><LinkButton href={tenantHref(tenantId,"administration")}>Manage access</LinkButton></div>}/><AccessTabs tenantId={tenantId} active="overview"/><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><ResourceSummary title="Members" description="Users with tenant access." href={tenantHref(tenantId,"administration")} count={memberRows.length} icon={<UsersIcon/>} loading={memberships.loading} error={memberships.error}/><ResourceSummary title="Invitations" description="Pending access invitations." href={tenantHref(tenantId,"administration")} count={inviteRows.length} icon={<ActivityIcon/>} loading={invitations.loading} error={invitations.error}/><ResourceSummary title="Identity providers" description="Tenant federation and SSO." href={tenantHref(tenantId,"administration")} count={idpRows.length} icon={<KeyIcon/>} loading={idps.loading} error={idps.error}/><ResourceSummary title="Machine identities" description="OAuth apps and service identities." href={tenantHref(tenantId,"credentials")} count={oauthRows.length+identityRows.length} icon={<ServerIcon/>} loading={oauth.loading||identities.loading} error={oauth.error||identities.error}/></div><div className="mt-6 grid gap-6 xl:grid-cols-[1.2fr_.8fr]"><Card className="overflow-hidden"><div className="border-b border-[#E1E7F0] px-5 py-4"><h2 className="font-semibold">Memberships</h2><p className="mt-0.5 text-xs text-[#718096]">Existing human access to this tenant.</p></div><DataTable embedded loading={memberships.loading} columns={[{key:"member",label:"Member"},{key:"status",label:"Status"},{key:"roles",label:"Roles"}]} rows={memberRows.map(m=>({key:idOf(m),cells:{member:<strong>{text(m.displayName,text(m.email,text((m.user as R|undefined)?.email,"Member")))}</strong>,status:<StatusText tone={statusTone(m.status)}>{text(m.status,"Active")}</StatusText>,roles:Array.isArray(m.roles)?(m.roles as R[]).map(r=>text(r.name)).join(", "):text(m.roleName,"—")}}))} empty={<EmptyState icon={<UsersIcon/>} title="No memberships" description="Invite a user to grant tenant access."/>}/></Card><div className="space-y-6"><Card className="p-5"><h2 className="font-semibold">Access model</h2><dl className="mt-4 grid grid-cols-2 gap-4 text-sm"><div><dt className="text-[#718096]">Roles</dt><dd className="mt-1 text-xl font-semibold">{roleRows.length}</dd></div><div><dt className="text-[#718096]">Groups</dt><dd className="mt-1 text-xl font-semibold">{groupRows.length}</dd></div><div><dt className="text-[#718096]">OAuth apps</dt><dd className="mt-1 text-xl font-semibold">{oauthRows.length}</dd></div><div><dt className="text-[#718096]">Service identities</dt><dd className="mt-1 text-xl font-semibold">{identityRows.length}</dd></div></dl><div className="mt-5 flex flex-wrap gap-2"><LinkButton className="h-8 px-3 text-xs" href={tenantHref(tenantId,"administration")}>Roles & groups</LinkButton><LinkButton className="h-8 px-3 text-xs" href={tenantHref(tenantId,"credentials")}>Machine credentials</LinkButton></div></Card><Card className="p-5"><h2 className="font-semibold">Federation</h2><p className="mt-1 text-sm text-[#5B6678]">{idpRows.length?`${idpRows.length} identity provider${idpRows.length===1?"":"s"} configured.`:"No tenant identity providers configured."}</p><LinkButton className="mt-4 h-8 px-3 text-xs" href={tenantHref(tenantId,"administration")}>Manage identity providers</LinkButton></Card></div></div></main>;
}

export function TenantActivity({tenantId}:{tenantId:string}) {
  const root=`/api/tenants/${encodeURIComponent(tenantId)}`; const operations=useApi<unknown>(`${root}/operations`); const audit=useApi<unknown>(`${root}/audit-log`); const opRows=items<R>(operations.data); const auditRows=items<R>(audit.data);
  return <main><PageHeader eyebrow="Tenant history" title="Activity" description="Operations and audit history for changes made in this tenant." actions={<div className="flex gap-2"><LinkButton href={tenantHref(tenantId,"operations")}>Operations</LinkButton><LinkButton href={tenantHref(tenantId,"audit")}>Audit log</LinkButton></div>}/><div className="grid gap-6 xl:grid-cols-2"><Card className="overflow-hidden"><div className="flex items-center gap-2 border-b border-[#E1E7F0] px-5 py-4"><ActivityIcon className="text-[#1769E0]"/><h2 className="font-semibold">Operations</h2></div><DataTable embedded loading={operations.loading} columns={[{key:"operation",label:"Operation"},{key:"status",label:"Status"},{key:"time",label:"Timestamp"}]} rows={opRows.slice(0,12).map(o=>({key:idOf(o),href:tenantHref(tenantId,"operations",idOf(o)),cells:{operation:<strong>{text(o.type,"Operation").replaceAll("_"," ")}</strong>,status:<StatusText tone={statusTone(o.status)}>{text(o.status,"Unknown")}</StatusText>,time:formatDate(o.createdAt??o.updatedAt)}}))} empty={<EmptyState icon={<ActivityIcon/>} title="No operations" description="Runtime and deployment jobs will appear here."/>}/></Card><Card className="overflow-hidden"><div className="flex items-center gap-2 border-b border-[#E1E7F0] px-5 py-4"><GridIcon className="text-[#1769E0]"/><h2 className="font-semibold">Audit log</h2></div><DataTable embedded loading={audit.loading} columns={[{key:"action",label:"Action"},{key:"actor",label:"Actor"},{key:"time",label:"Timestamp"}]} rows={auditRows.slice(0,12).map(a=>({key:idOf(a)||`${text(a.action)}-${text(auditTimestampValue(a))}`,cells:{action:<div><strong>{auditActionLabel(a)}</strong>{auditActionDetail(a)?<span className="mt-0.5 block text-xs font-normal text-[#718096]">{auditActionDetail(a)}</span>:isGroupedBillingUsage(a)?<span className="mt-0.5 block text-xs font-normal text-[#718096]">{auditGroupedCount(a)} recurring usage events grouped</span>:null}</div>,actor:text(a.actorName,text(a.actorDisplayName,text(a.actorEmail,text(a.actor,"System")))),time:formatDate(auditTimestampValue(a))}}))} empty={<EmptyState icon={<GridIcon/>} title="No audit records" description="Security and configuration changes will appear here."/>}/></Card></div></main>;
}

export function TenantBilling({tenantId}:{tenantId:string}) {
  const root=`/api/tenants/${encodeURIComponent(tenantId)}`;
  const billing=useApi<R>(`${root}/billing`);
  const quota=useApi<R|undefined>(`${root}/quota`);
  const [usageRange,setUsageRange]=useState<BillingUsageRange>("7d");
  const usagePath=useMemo(()=>{
    const params=new URLSearchParams({bucket:billingUsageBucket(usageRange)});
    const from=billingUsageRangeFrom(usageRange);
    if(from) params.set("from",from);
    return `${root}/billing/usage-series?${params.toString()}`;
  },[root,usageRange]);
  const usage=useApi<unknown>(usagePath);
  const [voucherCode,setVoucherCode]=useState("");
  const [working,setWorking]=useState<string>();

  async function redeemVoucher(){
    const code=voucherCode.trim().toUpperCase();
    if(!code)return;
    setWorking("voucher");
    try{
      await apiRequest(`${root}/billing/vouchers/redeem`,{method:"POST",body:{code}});
      setVoucherCode("");
      await billing.reload();
      toast.success("Voucher redeemed and credits added.");
    }catch(c){
      toast.errorFrom(c,"Voucher could not be redeemed.");
    }finally{
      setWorking(undefined);
    }
  }

  const usageRows=items<R>(usage.data);
  const state=text(billing.data?.billingState,text(billing.data?.state,"Unknown"));
  const showQuota = (value: unknown, unit = "") => quota.loading ? "Loading…" : quota.error ? "Unavailable" : quotaDisplay(value, unit);
  const showQuotaBytes = (value: unknown) => quota.loading ? "Loading…" : quota.error ? "Unavailable" : quotaBytesDisplay(value);

  return <main>
    <PageHeader eyebrow="Tenant finance" title="Billing" description="Balance, quota and usage over time."/>
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <BillingMetricCard icon={<BillingIcon/>} label="Balance" value={<>{formatPlnAmount(billing.data?.balancePln ?? "0")} PLN</>} detail={<>{formatCreditAmount(billing.data?.balanceCredits ?? billing.data?.balance ?? "0")} credits</>} badge={<StatusBadge tone={statusTone(state)}>{state}</StatusBadge>}/>
      <BillingMetricCard icon={<CpuIcon/>} label="CPU quota" value={showQuota(quota.data?.cpu, "cores")} detail="CPU limit"/>
      <BillingMetricCard icon={<MemoryIcon/>} label="Memory quota" value={showQuotaBytes(quota.data?.memoryBytes)} detail="memory limit"/>
      <BillingMetricCard icon={<VolumeIcon/>} label="Storage quota" value={showQuotaBytes(quota.data?.storageBytes)} detail="storage limit"/>
    </div>

    <div className="mt-6 grid gap-6 xl:grid-cols-[1fr_.8fr]">
      <Card className="p-5">
        <h2 className="font-semibold">Quota</h2>
        <p className="mt-1 text-sm text-[#5B6678]">Allocated by Platform Admin. Quotas are read-only for tenant members; contact your platform administrator to request changes.</p>
        <dl className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {([
            ["CPU cores", showQuota(quota.data?.cpu, "cores")],
            ["Memory", showQuotaBytes(quota.data?.memoryBytes)],
            ["GPU", showQuota(quota.data?.gpu)],
            ["Storage", showQuotaBytes(quota.data?.storageBytes)],
            ["Max applications", showQuota(quota.data?.maxSingleApps)],
            ["Max volumes", showQuota(quota.data?.maxVolumes)],
          ] as const).map(([label,value]) => (
            <div key={label}><dt className="text-xs text-[#718096]">{label}</dt><dd className="mt-1 font-semibold">{value}</dd></div>
          ))}
        </dl>
      </Card>

      <Card className="p-5">
        <h2 className="font-semibold">Redeem voucher</h2>
        <p className="mt-1 text-sm text-[#5B6678]">To add funds, request a voucher from your platform administrator, then enter the issued RPV code below. Only Platform Admin can issue vouchers or adjust balances.</p>
        <div className="mt-5 space-y-4">
          <Field label="Voucher code" required hint="Enter the RPV-… code issued by the platform administrator.">
            <TextInput autoComplete="off" value={voucherCode} onChange={e=>setVoucherCode(e.target.value)} placeholder="RPV-…" />
          </Field>
          <Button variant="primary" disabled={working==="voucher"||!voucherCode.trim()} onClick={()=>void redeemVoucher()}>{working==="voucher"?"Redeeming…":"Redeem voucher"}</Button>
        </div>
      </Card>
    </div>

    <div className="mt-6 space-y-6">
      <Card className="overflow-hidden">
        <div className="border-b border-[#E1E7F0] px-5 py-4">
          <h2 className="font-semibold">Usage</h2>
          <p className="mt-0.5 text-xs text-[#718096]">Billing cost and workload usage over time. Select a period and the series you want to compare.</p>
        </div>
        <BillingUsageCharts rows={usageRows} loading={usage.loading} error={usage.error} range={usageRange} onRangeChange={setUsageRange}/>
      </Card>

    </div>
  </main>;
}
