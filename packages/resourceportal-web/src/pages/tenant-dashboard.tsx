import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../api/client";
import { tenantHref } from "../router/router";
import {
  ActivityIcon,
  BillingIcon,
  Callout,
  Card,
  EmptyState,
  GlobeIcon,
  GridIcon,
  LinkButton,
  MetricCard,
  PageHeader,
  ServerIcon,
  StatusBadge,
  VolumeIcon,
  statusTone,
} from "../components/design-system";

type RecordValue = Record<string, unknown>;
type PanelState<T> = { data?: T; error?: unknown; loading: boolean };

function isRecord(value: unknown): value is RecordValue {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function dashboardItems(value: unknown): RecordValue[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (isRecord(value)) {
    for (const key of ["items", "records", "data", "results"]) {
      if (Array.isArray(value[key])) return dashboardItems(value[key]);
    }
  }
  return [];
}

function usePanel<T = unknown>(path: string): PanelState<T> {
  const [state, setState] = useState<PanelState<T>>({ loading: true });
  useEffect(() => {
    let active = true;
    setState({ loading: true });
    apiRequest<T>(path)
      .then((data) => { if (active) setState({ data, loading: false }); })
      .catch((error) => { if (active) setState({ error, loading: false }); });
    return () => { active = false; };
  }, [path]);
  return state;
}

function text(value: unknown, fallback = "—") {
  return typeof value === "string" && value ? value : fallback;
}

function numericString(value: unknown) {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
  return Number.isFinite(n) ? n : 0;
}

function formatBytes(value: number) {
  if (value <= 0) return "0 GB";
  const gb = value / 1_000_000_000;
  const rounded = gb >= 10 || Number.isInteger(gb) ? Math.round(gb) : Math.round(gb * 10) / 10;
  return `${rounded.toLocaleString("en-US")} GB`;
}

const attentionBlockers = new Set(["TenantSuspended", "BillingSuspended", "PlatformMaintenance", "AppGroupError"]);

function blockerLabel(blocker: string) {
  const labels: Record<string, string> = {
    TenantSuspended: "The tenant is suspended.",
    PlatformMaintenance: "Platform maintenance is currently blocking runtime operations.",
    AppGroupError: "The application group needs attention before it can run.",
    AppGroupDeleting: "The application group is being deleted.",
    AppGroupNotDeployed: "Deploy the current configuration before starting it.",
  };
  return labels[blocker] ?? blocker.replace(/([a-z])([A-Z])/g, "$1 $2");
}

function ResourceStatusRow({ label, detail, tone = "neutral" }: { label: string; detail: string; tone?: "neutral" | "success" | "warning" | "danger" | "info" }) {
  return <div className="flex items-center justify-between gap-3 py-2.5"><span className="text-[13px] font-medium text-[#172033]">{label}</span><StatusBadge tone={tone}>{detail}</StatusBadge></div>;
}

export function TenantDashboard({ tenantId }: { tenantId: string }) {
  const root = `/api/tenants/${encodeURIComponent(tenantId)}`;
  const tenant = usePanel<RecordValue>(root);
  const appGroupsState = usePanel(`${root}/app-groups`);
  const billing = usePanel<RecordValue>(`${root}/billing`);
  const volumesState = usePanel(`${root}/volumes`);
  const operationsState = usePanel(`${root}/operations`);

  const appGroups = useMemo(() => dashboardItems(appGroupsState.data), [appGroupsState.data]);
  const volumes = useMemo(() => dashboardItems(volumesState.data), [volumesState.data]);
  const operations = useMemo(() => dashboardItems(operationsState.data), [operationsState.data]);
  const running = appGroups.filter((g) => g.effectiveRuntimeState === "Running").length;
  const appCount = appGroups.reduce((sum, g) => sum + (Array.isArray(g.singleApps) ? g.singleApps.length : 0), 0);
  const totalBytes = volumes.reduce((sum, v) => sum + numericString(v.sizeBytes), 0);
  const usedBytes = volumes.reduce((sum, v) => sum + numericString(v.usedSizeBytes), 0);
  const balanceCredits = billing.data ? text(billing.data.balanceCredits, text(billing.data.balance, "0")) : "0";
  const balancePln = billing.data ? text(billing.data.balancePln, "0") : "0";
  const billingSuspended = billing.data?.billingState === "BillingSuspended" || billing.data?.state === "Suspended";
  const lowBalance = billing.data?.lowBalance === true;
  const blockedGroups = appGroups.filter((g) => Array.isArray(g.runtimeBlockers) && (g.runtimeBlockers as unknown[]).some((b) => typeof b === "string" && attentionBlockers.has(b)));
  const billingBlockedGroups = blockedGroups.filter((g) => (g.runtimeBlockers as unknown[]).includes("BillingSuspended"));
  const otherBlockedGroups = blockedGroups.filter((g) => (g.runtimeBlockers as unknown[]).some((b) => typeof b === "string" && b !== "BillingSuspended" && attentionBlockers.has(b)));
  const tenantName = tenant.data ? text(tenant.data.displayName, text(tenant.data.name, tenantId)) : tenantId;

  return <main>
    <PageHeader
      eyebrow="ResourcePortal"
      title="Tenant Overview"
      description={tenant.loading ? "Loading tenant overview…" : tenant.error ? "Tenant details are currently unavailable." : `Here's what's happening across ${tenantName}.`}
    />

    <section className="mb-6" aria-label="Quick actions">
      <h2 className="mb-3 text-sm font-semibold text-[#42526B]">Quick actions</h2>
      <div className="flex flex-wrap gap-3">
        <LinkButton variant="primary" href={`${tenantHref(tenantId, "applications")}/new`}><GridIcon size={16}/>Create App Group</LinkButton>
        <LinkButton href={tenantHref(tenantId, "volumes")}><VolumeIcon size={16}/>Create Volume</LinkButton>
        <LinkButton href={tenantHref(tenantId, "domains")}><GlobeIcon size={16}/>Add Domain</LinkButton>
      </div>
    </section>

    <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Tenant summary">
      <div data-testid="metric-applications"><MetricCard label="Applications" icon={<GridIcon/>} value={String(appCount)} detail={`Across ${appGroups.length} App Group${appGroups.length === 1 ? "" : "s"}`} loading={appGroupsState.loading} error={appGroupsState.error}/></div>
      <div data-testid="metric-runtime"><MetricCard label="Running workloads" icon={<ServerIcon/>} value={String(running)} detail={`${Math.max(appGroups.length - running, 0)} App Group${appGroups.length - running === 1 ? "" : "s"} not running`} loading={appGroupsState.loading} error={appGroupsState.error} tone={running === appGroups.length && appGroups.length ? "success" : "info"}/></div>
      <div data-testid="metric-storage"><MetricCard label="Storage usage" icon={<VolumeIcon/>} value={`${formatBytes(usedBytes)} / ${formatBytes(totalBytes)}`} detail={`${volumes.length} volume${volumes.length === 1 ? "" : "s"}`} loading={volumesState.loading} error={volumesState.error}/></div>
      <div data-testid="metric-balance"><MetricCard label="Current balance" icon={<BillingIcon/>} value={`${balancePln} PLN`} detail={`${balanceCredits} credits`} loading={billing.loading} error={billing.error} tone={billingSuspended ? "danger" : lowBalance ? "warning" : "success"}/></div>
    </section>

    <div className="mt-6 grid gap-6 xl:grid-cols-2">
      <section aria-label="Needs attention">
        <Card className="h-full overflow-hidden">
          <div className="flex items-center justify-between border-b border-[#E1E7F0] px-5 py-4"><h2 className="text-base font-semibold">Needs attention</h2><span className="text-sm font-semibold text-[#B54708]">{(billingSuspended || lowBalance ? 1 : 0) + otherBlockedGroups.length}</span></div>
          <div className="space-y-3 p-4 sm:p-5">
            {billing.loading || appGroupsState.loading ? <p className="text-sm text-[#5B6678]">Checking tenant state…</p> : null}
            {!billing.loading && !appGroupsState.loading && !billingSuspended && !lowBalance && otherBlockedGroups.length === 0 ? <Callout tone="success" title="No urgent issues">Your tenant has no known runtime or billing blockers.</Callout> : null}
            {billingSuspended ? <Callout tone="danger" title="Applications are paused because your balance is empty" action={<div className="flex flex-wrap gap-2"><LinkButton className="h-8 px-3 text-xs" href={tenantHref(tenantId, "billing")}>Go to billing</LinkButton>{billingBlockedGroups.slice(0, 2).map((g) => <LinkButton className="h-8 px-3 text-xs" key={String(g.id)} href={tenantHref(tenantId, "app-groups", String(g.id))}>Open {text(g.name, "App Group")}</LinkButton>)}</div>}>Add credits to resume workloads that are blocked by billing.</Callout> : lowBalance ? <Callout tone="warning" title="Your balance is running low" action={<LinkButton className="h-8 px-3 text-xs" href={tenantHref(tenantId, "billing")}>Review billing</LinkButton>}>Top up before workloads are suspended.</Callout> : null}
            {otherBlockedGroups.map((g) => { const blockers = (g.runtimeBlockers as unknown[]).filter((v): v is string => typeof v === "string" && v !== "BillingSuspended" && attentionBlockers.has(v)); if (!blockers.length) return null; return <Callout key={String(g.id)} tone="warning" title={`${text(g.name, "App Group")} needs attention`} action={<LinkButton className="h-8 px-3 text-xs" href={tenantHref(tenantId, "app-groups", String(g.id))}>Open App Group</LinkButton>}>{blockerLabel(blockers[0])}</Callout>; })}
          </div>
        </Card>
      </section>

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-[#E1E7F0] px-5 py-4"><h2 className="text-base font-semibold">Recent App Groups</h2><a className="text-xs font-semibold text-[#0F56A7] hover:underline" href={tenantHref(tenantId, "applications")}>View all</a></div>
        {appGroupsState.error ? <p className="p-5 text-sm text-[#B42318]">Applications are unavailable.</p> : appGroupsState.loading ? <p className="p-5 text-sm text-[#5B6678]">Loading applications…</p> : appGroups.length === 0 ? <div className="p-5"><EmptyState icon={<GridIcon/>} title="No App Groups yet" description="Create the first deployment workspace for this tenant." action={<LinkButton variant="primary" href={`${tenantHref(tenantId, "applications")}/new`}>Create App Group</LinkButton>}/></div> : <div className="divide-y divide-[#E1E7F0]">{appGroups.slice(0, 6).map((g) => { const state = text(g.effectiveRuntimeState, text(g.runtimeState, "Unknown")); const health = text(g.health, "Unknown"); const apps = Array.isArray(g.singleApps) ? g.singleApps.length : 0; return <a key={String(g.id)} href={tenantHref(tenantId, "app-groups", String(g.id))} className="grid gap-3 px-5 py-4 hover:bg-[#F8FAFD] sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"><div className="min-w-0"><strong className="block truncate text-sm">{text(g.name, "Unnamed App Group")}</strong><span className="text-xs text-[#718096]">{apps} app{apps === 1 ? "" : "s"}</span></div><div className="flex flex-wrap gap-2"><StatusBadge tone={statusTone(state)}>{state}</StatusBadge><StatusBadge tone={statusTone(health)}>{health}</StatusBadge></div></a>; })}</div>}
      </Card>
    </div>

    <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1.65fr)_minmax(300px,.75fr)]">
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-[#E1E7F0] px-5 py-4"><h2 className="text-base font-semibold">Recent activity</h2><a className="text-xs font-semibold text-[#0F56A7] hover:underline" href={tenantHref(tenantId, "activity")}>View all</a></div>
        {operationsState.error ? <p className="p-5 text-sm text-[#B42318]">Recent operations are unavailable.</p> : operationsState.loading ? <p className="p-5 text-sm text-[#5B6678]">Loading activity…</p> : operations.length === 0 ? <p className="p-5 text-sm text-[#5B6678]">No recent operations.</p> : <div className="divide-y divide-[#E1E7F0]">{operations.slice(0, 5).map((op) => <a className="flex items-start gap-3 px-5 py-3 hover:bg-[#F8FAFD]" href={tenantHref(tenantId, "operations", String(op.id))} key={String(op.id)}><span className="mt-1 text-[#1769E0]"><ActivityIcon size={15}/></span><div className="min-w-0"><strong className="block truncate text-[13px]">{text(op.type, "Operation").replaceAll("_", " ")}</strong><span className="text-xs text-[#718096]">{text(op.status, "Unknown")}</span></div></a>)}</div>}
      </Card>

      <Card className="p-5">
        <div className="mb-2 flex items-center gap-2"><ServerIcon size={17} className="text-[#1769E0]"/><h2 className="text-base font-semibold">Tenant resource status</h2></div>
        <div className="divide-y divide-[#E1E7F0]">
          <ResourceStatusRow label="Compute" detail={appGroupsState.loading ? "Checking" : appGroupsState.error ? "Unavailable" : `${running}/${appGroups.length} running`} tone={appGroupsState.error ? "danger" : running === appGroups.length && appGroups.length ? "success" : "info"}/>
          <ResourceStatusRow label="Storage" detail={volumesState.loading ? "Checking" : volumesState.error ? "Unavailable" : `${volumes.length} volume${volumes.length === 1 ? "" : "s"}`} tone={volumesState.error ? "danger" : "success"}/>
          <ResourceStatusRow label="Billing" detail={billing.loading ? "Checking" : billing.error ? "Unavailable" : billingSuspended ? "Suspended" : lowBalance ? "Low balance" : "Active"} tone={billing.error || billingSuspended ? "danger" : lowBalance ? "warning" : "success"}/>
          <ResourceStatusRow label="Activity" detail={operationsState.loading ? "Checking" : operationsState.error ? "Unavailable" : "Available"} tone={operationsState.error ? "danger" : "success"}/>
        </div>
      </Card>
    </div>
  </main>;
}
