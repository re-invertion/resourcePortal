import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../api/client";
import { tenantHref } from "../router/router";

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
    apiRequest<T>(path).then((data) => {
      if (active) setState({ data, loading: false });
    }).catch((error) => {
      if (active) setState({ error, loading: false });
    });
    return () => { active = false; };
  }, [path]);
  return state;
}

function text(value: unknown, fallback = "—") {
  return typeof value === "string" && value ? value : fallback;
}

function numericString(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function formatBytes(value: number) {
  if (value <= 0) return "0 GB";
  const gb = value / 1_000_000_000;
  const rounded = gb >= 10 || Number.isInteger(gb) ? Math.round(gb) : Math.round(gb * 10) / 10;
  return `${rounded.toLocaleString("en-US")} GB`;
}

function PanelMetric({ label, value, detail, loading, error, testId }: { label: string; value: string; detail: string; loading?: boolean; error?: unknown; testId: string }) {
  return <article className="rp-dashboard-metric" data-testid={testId}>
    <div className="rp-dashboard-metric-head"><span>{label}</span><span className="rp-dashboard-metric-icon" aria-hidden="true" /></div>
    {loading ? <strong className="rp-dashboard-metric-value">Loading…</strong> : error ? <><strong className="rp-dashboard-metric-value">Unavailable</strong><span>Try the dedicated page for details.</span></> : <><strong className="rp-dashboard-metric-value">{value}</strong><span>{detail}</span></>}
  </article>;
}

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

function statusTone(value: string) {
  const normalized = value.toLowerCase();
  if (["healthy", "ready", "running", "succeeded", "active", "insync"].includes(normalized.replace(/[^a-z]/g, ""))) return "positive";
  if (["failed", "error", "unhealthy", "blocked", "suspended"].some((part) => normalized.includes(part))) return "negative";
  if (["stopped", "pending", "unknown", "degraded", "maintenance"].some((part) => normalized.includes(part))) return "warning";
  return "neutral";
}

function Status({ children }: { children: string }) {
  return <span className="rp-status-pill" data-tone={statusTone(children)}>{children}</span>;
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
  const running = appGroups.filter((group) => group.effectiveRuntimeState === "Running").length;
  const appCount = appGroups.reduce((sum, group) => sum + (Array.isArray(group.singleApps) ? group.singleApps.length : 0), 0);
  const totalBytes = volumes.reduce((sum, volume) => sum + numericString(volume.sizeBytes), 0);
  const usedBytes = volumes.reduce((sum, volume) => sum + numericString(volume.usedSizeBytes), 0);
  const balanceCredits = billing.data ? text(billing.data.balanceCredits, text(billing.data.balance, "0")) : "0";
  const balancePln = billing.data ? text(billing.data.balancePln, "0") : "0";
  const billingSuspended = billing.data?.billingState === "BillingSuspended" || billing.data?.state === "Suspended";
  const lowBalance = billing.data?.lowBalance === true;
  const blockedGroups = appGroups.filter((group) => Array.isArray(group.runtimeBlockers) && group.runtimeBlockers.length > 0);
  const billingBlockedGroups = blockedGroups.filter((group) => (group.runtimeBlockers as unknown[]).includes("BillingSuspended"));
  const otherBlockedGroups = blockedGroups.filter((group) => !(group.runtimeBlockers as unknown[]).every((blocker) => blocker === "BillingSuspended"));
  const tenantName = tenant.data ? text(tenant.data.displayName, text(tenant.data.name, tenantId)) : tenantId;

  return <main className="rp-dashboard-page">
    <header className="rp-page-hero">
      <div><p className="rp-eyebrow">Tenant control center</p><h1>{tenant.loading ? "Loading tenant…" : tenant.error ? "Tenant dashboard" : tenantName}</h1><p>Everything important about your workloads, spend and recent activity in one place.</p></div>
      <div className="rp-page-actions"><a className="rp-button rp-button-primary" href={tenantHref(tenantId, "app-groups")}>Create App Group</a></div>
    </header>

    <section className="rp-metric-grid" aria-label="Tenant summary">
      <PanelMetric testId="metric-applications" label="Applications" loading={appGroupsState.loading} error={appGroupsState.error} value={String(appGroups.length)} detail={`${appCount} apps configured`} />
      <PanelMetric testId="metric-runtime" label="Runtime" loading={appGroupsState.loading} error={appGroupsState.error} value={`${running} running`} detail={`${Math.max(appGroups.length - running, 0)} not running`} />
      <PanelMetric testId="metric-balance" label="Balance" loading={billing.loading} error={billing.error} value={`${balanceCredits} credits`} detail={`≈ ${balancePln} PLN`} />
      <PanelMetric testId="metric-storage" label="Storage" loading={volumesState.loading} error={volumesState.error} value={`${formatBytes(usedBytes)} / ${formatBytes(totalBytes)}`} detail={`${volumes.length} volume${volumes.length === 1 ? "" : "s"}`} />
    </section>

    <section className="rp-dashboard-section rp-attention-section" aria-label="Needs attention">
      <header><div><p className="rp-eyebrow">Priority</p><h2>Needs attention</h2></div><span className="rp-section-count">{(billingSuspended || lowBalance ? 1 : 0) + otherBlockedGroups.length}</span></header>
      {billing.loading || appGroupsState.loading ? <p className="rp-muted">Checking tenant state…</p> : null}
      {!billing.loading && !appGroupsState.loading && !billingSuspended && !lowBalance && otherBlockedGroups.length === 0 ? <div className="rp-good-state"><strong>No urgent issues</strong><span>Your tenant has no known runtime or billing blockers.</span></div> : null}
      {billingSuspended ? <article className="rp-attention-card" data-tone="negative"><div><strong>Applications are paused because your balance is empty</strong><p>Add credits to resume workloads that are blocked by billing.</p></div><div className="rp-attention-actions"><a href={tenantHref(tenantId, "billing")}>Go to billing</a>{billingBlockedGroups.slice(0, 2).map((group) => <a key={String(group.id)} href={tenantHref(tenantId, "app-groups", String(group.id))}>Open {text(group.name, "App Group")}</a>)}</div></article> : lowBalance ? <article className="rp-attention-card" data-tone="warning"><div><strong>Your balance is running low</strong><p>Top up before workloads are suspended.</p></div><a href={tenantHref(tenantId, "billing")}>Review billing</a></article> : null}
      {otherBlockedGroups.map((group) => {
        const blockers = (group.runtimeBlockers as unknown[]).filter((value): value is string => typeof value === "string" && value !== "BillingSuspended");
        if (blockers.length === 0) return null;
        return <article className="rp-attention-card" data-tone="warning" key={String(group.id)}><div><strong>{text(group.name, "App Group")} needs attention</strong><p>{blockerLabel(blockers[0])}</p></div><a href={tenantHref(tenantId, "app-groups", String(group.id))}>Open App Group</a></article>;
      })}
    </section>

    <div className="rp-dashboard-columns">
      <section className="rp-dashboard-section">
        <header><div><p className="rp-eyebrow">Workloads</p><h2>Applications</h2></div><a href={tenantHref(tenantId, "app-groups")}>View all</a></header>
        {appGroupsState.error ? <p className="rp-panel-unavailable">Applications are unavailable.</p> : appGroupsState.loading ? <p className="rp-muted">Loading applications…</p> : appGroups.length === 0 ? <div className="rp-empty-compact"><strong>No App Groups yet</strong><a href={tenantHref(tenantId, "app-groups")}>Create your first App Group</a></div> : <div className="rp-application-list">{appGroups.slice(0, 6).map((group) => {
          const state = text(group.effectiveRuntimeState, text(group.runtimeState, "Unknown"));
          const health = text(group.health, "Unknown");
          const apps = Array.isArray(group.singleApps) ? group.singleApps.length : 0;
          return <a className="rp-application-row" href={tenantHref(tenantId, "app-groups", String(group.id))} key={String(group.id)}><div className="rp-app-identity"><span className="rp-app-mark" aria-hidden="true">{text(group.name, "A").slice(0, 1).toUpperCase()}</span><div><strong>{text(group.name, "Unnamed App Group")}</strong><span>{apps} app{apps === 1 ? "" : "s"}</span></div></div><div className="rp-app-status"><Status>{state}</Status><Status>{health}</Status></div><span className="rp-row-chevron" aria-hidden="true">›</span></a>;
        })}</div>}
      </section>

      <aside className="rp-dashboard-rail">
        <section className="rp-dashboard-section">
          <header><div><p className="rp-eyebrow">Shortcuts</p><h2>Quick actions</h2></div></header>
          <div className="rp-quick-actions">
            <a href={tenantHref(tenantId, "app-groups")}>Create App Group <span>→</span></a>
            <a href={tenantHref(tenantId, "volumes")}>Create Volume <span>→</span></a>
            <a href={tenantHref(tenantId, "domains")}>Add Domain <span>→</span></a>
            <a href={tenantHref(tenantId, "administration")}>Invite member <span>→</span></a>
          </div>
        </section>
        <section className="rp-dashboard-section">
          <header><div><p className="rp-eyebrow">Latest</p><h2>Recent activity</h2></div><a href={tenantHref(tenantId, "operations")}>View all</a></header>
          {operationsState.error ? <p className="rp-panel-unavailable">Recent operations are unavailable.</p> : operationsState.loading ? <p className="rp-muted">Loading activity…</p> : operations.length === 0 ? <p className="rp-muted">No recent operations.</p> : <div className="rp-activity-list">{operations.slice(0, 5).map((operation) => <a href={tenantHref(tenantId, "operations", String(operation.id))} key={String(operation.id)}><span className="rp-activity-dot" data-tone={statusTone(text(operation.status, "Unknown"))} /><div><strong>{text(operation.type, "Operation").replaceAll("_", " ")}</strong><span>{text(operation.status, "Unknown")}</span></div></a>)}</div>}
        </section>
      </aside>
    </div>
  </main>;
}
