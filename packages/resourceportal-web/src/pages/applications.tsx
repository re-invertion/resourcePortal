import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../api/client";
import { appGroupHref, tenantHref } from "../router/router";
import { Button, Card, DataTable, EmptyState, FileIcon, GridIcon, LinkButton, MetricCard, MoreIcon, PageHeader, PlusIcon, SearchField, Select, StatusText, statusTone } from "../components/design-system";
import { AppGroupIcon } from "../components/application-icon";

type Group = Record<string, unknown>;
function list(value: unknown): Group[] { if (Array.isArray(value)) return value.filter((x): x is Group => !!x && typeof x === "object"); if (value && typeof value === "object") { const v = value as Group; for (const key of ["items", "data", "results"]) if (Array.isArray(v[key])) return list(v[key]); } return []; }
function text(value: unknown, fallback = "—") { return typeof value === "string" && value ? value : fallback; }
function countApps(group: Group) { return Array.isArray(group.singleApps) ? group.singleApps.length : typeof group.appCount === "number" ? group.appCount : 0; }
function relative(value: unknown) { if (typeof value !== "string") return "—"; const time = Date.parse(value); if (!Number.isFinite(time)) return value; const delta = Date.now() - time; const min = Math.max(0, Math.floor(delta / 60000)); if (min < 1) return "Just now"; if (min < 60) return `${min} min ago`; const h = Math.floor(min / 60); if (h < 24) return `${h} h ago`; const d = Math.floor(h / 24); return d === 1 ? "Yesterday" : `${d} d ago`; }

export function ApplicationsPage({ tenantId }: { tenantId: string }) {
  const [groups, setGroups] = useState<Group[]>([]); const [loading, setLoading] = useState(true); const [error, setError] = useState<unknown>(); const [refreshError, setRefreshError] = useState(false); const [search, setSearch] = useState(""); const [state, setState] = useState("all"); const [health, setHealth] = useState("all"); const [chooseAppGroup, setChooseAppGroup] = useState(false);
  useEffect(() => {
    let active = true;
    let inFlight = false;
    let hasLoaded = false;
    setGroups([]);
    setLoading(true);
    setError(undefined);
    setRefreshError(false);
    // Refresh the inventory after external deployments without disrupting filters.
    const refresh = async () => {
      if (!active || inFlight || (typeof document !== "undefined" && document.visibilityState === "hidden")) return;
      inFlight = true;
      try {
        const value = await apiRequest(`/api/tenants/${encodeURIComponent(tenantId)}/app-groups`);
        if (active) {
          hasLoaded = true;
          setGroups(list(value));
          setError(undefined);
          setRefreshError(false);
        }
      } catch (cause) {
        if (active) {
          // A failed background refresh must not hide a usable cached list.
          if (hasLoaded) setRefreshError(true);
          else setError(cause);
        }
      } finally {
        inFlight = false;
        if (active) setLoading(false);
      }
    };
    void refresh();
    const handle = window.setInterval(() => void refresh(), 15_000);
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { active = false; window.clearInterval(handle); document.removeEventListener("visibilitychange", onVisible); };
  }, [tenantId]);
  const filtered = useMemo(() => groups.filter(group => { const name = text(group.name, "").toLowerCase(); const runtime = text(group.effectiveRuntimeState, text(group.runtimeState, "unknown")).toLowerCase(); const h = text(group.health, "unknown").toLowerCase(); return name.includes(search.toLowerCase()) && (state === "all" || runtime === state) && (health === "all" || h === health); }), [groups, search, state, health]);
  const running = groups.filter(group => text(group.effectiveRuntimeState, group.runtimeState as string).toLowerCase() === "running").length; const appCount = groups.reduce((sum, g) => sum + countApps(g), 0); const attention = groups.filter(g => statusTone(g.health) === "danger" || g.hasPendingChanges === true).length;
  const rows = filtered.map(group => { const id = String(group.id ?? ""); const runtime = text(group.effectiveRuntimeState, group.runtimeState as string); const groupHealth = text(group.health, "Unknown"); const deployment = group.currentDeploymentVersion == null ? "—" : `v${String(group.currentDeploymentVersion)}`; const apps = countApps(group); return { key: id, href: appGroupHref(tenantId, id), cells: { name: <span className="flex items-center gap-3"><AppGroupIcon apps={Array.isArray(group.singleApps) ? group.singleApps.filter((item): item is Group => Boolean(item) && typeof item === "object") : []} className="h-10 w-10 rounded-lg"/><span><span className="block font-semibold text-[#172033]">{text(group.name, "Unnamed App Group")}</span><span className="mt-0.5 block text-[11px] font-normal text-[#718096]">App Group</span></span></span>, apps: `${apps} app${apps === 1 ? "" : "s"}`, runtime: <StatusText tone={statusTone(runtime)}>{runtime}</StatusText>, health: <StatusText tone={statusTone(groupHealth)}>{groupHealth}</StatusText>, deployment, changes: <StatusText tone={group.hasPendingChanges === true ? "warning" : "neutral"}>{group.hasPendingChanges === true ? "Pending changes" : "Up to date"}</StatusText>, updated: relative(group.updatedAt ?? group.createdAt), action: <a aria-label={`Open ${text(group.name, "App Group")}`} href={appGroupHref(tenantId, id)} className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-[#EEF3F9]"><MoreIcon size={17}/></a> } }; });
  return <main>
    <PageHeader eyebrow="Workloads" title="Applications" description="Manage App Groups and the applications they contain." actions={<><Button onClick={() => setChooseAppGroup(value => !value)}><PlusIcon size={16}/>Create application</Button><LinkButton href={tenantHref(tenantId, "applications", "import")}><FileIcon size={16}/>Import YAML</LinkButton><LinkButton variant="primary" href={tenantHref(tenantId, "applications", "new")}><GridIcon size={16}/>Create App Group</LinkButton></>}/>
    {chooseAppGroup ? <Card className="mb-5 p-5" aria-label="Choose an App Group">
      <h2 className="text-base font-semibold">Choose an App Group</h2>
      <p className="mt-1 text-sm text-[#5B6678]">Applications belong to a group that is deployed together. Select a group to create an application, or create a new group first.</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {groups.map(group => <LinkButton key={String(group.id)} href={appGroupHref(tenantId, String(group.id), "apps/new")}>{text(group.name, "App Group")}</LinkButton>)}
        <LinkButton href={tenantHref(tenantId, "applications", "new")}><PlusIcon size={16}/>Create new App Group</LinkButton>
      </div>
    </Card> : null}
    <section className="mb-5 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Application summary"><MetricCard label="App Groups" value={groups.length} detail={`${appCount} apps configured`} loading={loading} error={error}/><MetricCard label="Running" value={running} detail={`${Math.max(0, groups.length-running)} not running`} tone="success" loading={loading} error={error}/><MetricCard label="Apps configured" value={appCount} detail={`Across ${groups.length} App Groups`} loading={loading} error={error}/><MetricCard label="Needs attention" value={attention} detail="Review runtime blockers" tone={attention ? "warning" : "success"} loading={loading} error={error}/></section>
    <Card className="overflow-hidden"><div className="px-5 py-4"><h2 className="text-base font-semibold text-[#172033]">App Groups</h2><p className="mt-0.5 text-[13px] text-[#5B6678]">An App Group is a group of applications deployed together. Create or open a group to add an application.</p></div><div className="flex flex-col gap-2 border-y border-[#E1E7F0] px-5 py-3 sm:flex-row sm:items-center"><SearchField value={search} onChange={setSearch} placeholder="Search App Groups" ariaLabel="Search App Groups"/><Select aria-label="Filter by state" value={state} onChange={e => setState(e.target.value)} className="sm:w-[150px]"><option value="all">State: All</option><option value="running">Running</option><option value="stopped">Stopped</option></Select><Select aria-label="Filter by health" value={health} onChange={e => setHealth(e.target.value)} className="sm:w-[160px]"><option value="all">Health: All</option><option value="healthy">Healthy</option><option value="warning">Warning</option><option value="unhealthy">Unhealthy</option><option value="unknown">Unknown</option></Select><span className="ml-auto whitespace-nowrap text-xs text-[#5B6678]">{filtered.length} App Group{filtered.length === 1 ? "" : "s"}</span></div>
    {refreshError ? <div role="status" className="mx-5 my-3 rounded-md border border-[#E7C775] bg-[#FFF9E8] px-4 py-3 text-sm text-[#825800]">Applications could not be refreshed. Showing the last loaded data; retrying automatically.</div> : null}
    {error ? <div className="p-5 text-sm text-[#C42B1C]">Applications could not be loaded. Refresh the page to retry.</div> : <DataTable embedded className="rounded-none border-0" loading={loading} columns={[{key:"name",label:"App Group"},{key:"apps",label:"Apps"},{key:"runtime",label:"Runtime"},{key:"health",label:"Health"},{key:"deployment",label:"Deployment"},{key:"changes",label:"Changes"},{key:"updated",label:"Updated"},{key:"action",label:""}]} rows={rows} empty={<EmptyState icon={<GridIcon/>} title="No App Groups match these filters" description="Clear filters or create an App Group to start deploying applications." action={<LinkButton variant="primary" href={tenantHref(tenantId,"applications","new")}><PlusIcon/>Create App Group</LinkButton>}/>} footer={filtered.length ? `1–${filtered.length} of ${filtered.length}` : undefined}/>}</Card>
  </main>;
}
