import { useState } from "react";
import { Button, Card, DataTable, EmptyState, ActivityIcon, ErrorState, Select, StatusText, TextInput, statusTone } from "../../components/design-system";
import { formatDate, idOf, items, text, useApi } from "../../hooks/use-api";
import { tenantHref } from "../../router/router";
import { belongsToAppGroup } from "./activity-scope";

type R = Record<string, unknown>;

export function AppGroupActivity({ tenantId, appGroupId }: { tenantId: string; appGroupId: string }) {
  const tenantRoot = `/api/tenants/${encodeURIComponent(tenantId)}`;
  const root = `${tenantRoot}/app-groups/${encodeURIComponent(appGroupId)}`;
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [chronology, setChronology] = useState("loaded");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const operations = useApi<unknown>(`${tenantRoot}/operations`);
  const apps = useApi<unknown>(`${root}/single-apps`);
  const deployments = useApi<unknown>(`${root}/deployments`);
  const appIds = new Set(items<R>(apps.data).map(idOf));
  const deploymentIds = new Set(items<R>(deployments.data).map(idOf));
  const loading = operations.loading || apps.loading || deployments.loading;
  const rows = !loading && !operations.error && !apps.error && !deployments.error
    ? items<R>(operations.data).filter(op => belongsToAppGroup(op, appGroupId, appIds, deploymentIds))
    : [];
  // Keep an active filter selectable if a refresh removes its last matching row.
  const statuses = Array.from(new Set([...rows.map(op => text(op.status, "Unknown")), ...(statusFilter === "all" ? [] : [statusFilter])])).sort();
  const query = search.trim().toLowerCase();
  const dateLimit = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const instant = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === value ? instant : null;
  };
  const fromTime = fromDate ? dateLimit(fromDate) : null;
  const toTime = toDate ? dateLimit(toDate) : null;
  const invalidDates = (Boolean(fromDate) && fromTime === null) || (Boolean(toDate) && toTime === null) || (fromTime !== null && toTime !== null && fromTime > toTime);
  const timestamp = (op: R) => {
    const value = op.createdAt ?? op.updatedAt;
    if (typeof value !== "string" && typeof value !== "number") return null;
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : null;
  };
  const visible = rows.filter(op => {
    if (invalidDates) return false;
    if (fromDate || toDate) {
      const time = timestamp(op);
      if (time === null || (fromTime !== null && time < fromTime) || (toTime !== null && time >= toTime + 86400000)) return false;
    }
    if (statusFilter !== "all" && text(op.status, "Unknown") !== statusFilter) return false;
    if (!query) return true;
    return [text(op.type, "").replaceAll("_", " "), op.type, op.resourceName, op.resourceType, op.status, op.createdByDisplayName, op.createdByEmail, op.createdBy, op.id]
      .some(value => text(value, "").toLowerCase().includes(query));
  });
  const sorted = visible.map((op, index) => ({ op, index })).sort((a, b) => {
    if (chronology === "loaded") return a.index - b.index;
    const left = timestamp(a.op);
    const right = timestamp(b.op);
    if (left === null && right !== null) return 1;
    if (right === null && left !== null) return -1;
    if (left === null || right === null || left === right) return a.index - b.index;
    return chronology === "newest" ? right - left : left - right;
  }).map(({ op }) => op);
  const clearFilters = () => { setSearch(""); setStatusFilter("all"); setChronology("loaded"); setFromDate(""); setToDate(""); };
  return <section className="space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-semibold">Activity</h2><p className="mt-1 text-sm text-[#5B6678]">Operations explicitly linked to this App Group, its apps or deployments. Unrelated tenant operations are excluded. Refresh reloads all three relationships before showing results.</p></div><Button disabled={loading} onClick={() => void Promise.all([operations.reload(), apps.reload(), deployments.reload()])}>{loading ? "Refreshing…" : "Refresh activity"}</Button></div>
    {operations.error || apps.error || deployments.error
      ? <ErrorState title="Activity relationships could not be verified" error={operations.error || apps.error || deployments.error} retry={() => void Promise.all([operations.reload(), apps.reload(), deployments.reload()])} />
      : <Card className="overflow-hidden"><div className="grid gap-3 border-b border-[#E1E7F0] p-4 sm:grid-cols-[minmax(0,1fr)_150px_150px_auto] sm:items-center"><TextInput aria-label="Search App Group activity" placeholder="Search operation or resource" value={search} onChange={event => setSearch(event.target.value)} /><Select aria-label="Filter App Group activity status" value={statusFilter} onChange={event => setStatusFilter(event.target.value)}><option value="all">All statuses</option>{statuses.map(status => <option key={status} value={status}>{status}</option>)}</Select><Select aria-label="Sort App Group activity" value={chronology} onChange={event => setChronology(event.target.value)}><option value="loaded">Loaded order</option><option value="newest">Newest first</option><option value="oldest">Oldest first</option></Select><Button size="sm" disabled={!search && statusFilter === "all" && chronology === "loaded" && !fromDate && !toDate} onClick={clearFilters}>Clear activity filters</Button></div><div className="flex flex-wrap gap-3 border-b border-[#E1E7F0] p-4"><label className="text-sm">From (UTC)<input type="date" aria-label="Activity from date" value={fromDate} onChange={event => setFromDate(event.target.value)} className="ml-2 rounded border px-2 py-1" /></label><label className="text-sm">To (UTC)<input type="date" aria-label="Activity to date" value={toDate} onChange={event => setToDate(event.target.value)} className="ml-2 rounded border px-2 py-1" /></label></div>{invalidDates && <p role="alert" className="px-4 py-2 text-sm text-red-700">Invalid activity date range. From must be on or before To. Clear or correct the dates to see activity.</p>}<p role="status" className="border-b border-[#E1E7F0] px-4 py-2 text-xs text-[#5B6678]">Showing {visible.length} of {rows.length} explicitly related operations from loaded tenant activity. Older operations may not be included.</p><DataTable embedded loading={loading}
        columns={[{ key: "type", label: "Operation" }, { key: "resource", label: "Resource" }, { key: "status", label: "Status" }, { key: "actor", label: "Actor" }, { key: "time", label: "Timestamp" }]}
        rows={sorted.map(op => ({
          key: idOf(op),
          href: tenantHref(tenantId, "operations", idOf(op)),
          cells: {
            type: <strong>{text(op.type, "Operation").replaceAll("_", " ")}</strong>,
            resource: text(op.resourceName, text(op.resourceType, "App Group")),
            status: <StatusText tone={statusTone(op.status)}>{text(op.status, "Unknown")}</StatusText>,
            actor: text(op.createdByDisplayName, text(op.createdByEmail, text(op.createdBy, "System"))),
            time: formatDate(op.createdAt ?? op.updatedAt),
          },
        }))}
        empty={<EmptyState icon={<ActivityIcon />} title="No matching activity" description="Only operations linked to this App Group and its workloads appear here. Change filters to view other loaded operations." />}
      /></Card>}
  </section>;
}
