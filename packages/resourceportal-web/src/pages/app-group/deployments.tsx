import { useEffect, useMemo, useRef, useState } from "react";
import { apiRequest } from "../../api/client";
import {
  Button, Card, ConfirmActionButton, DataTable, DeployIcon, EmptyState,
  Field, HistoryIcon, Select, StatusText, Textarea, TextInput, statusTone,
} from "../../components/design-system";
import { toast } from "../../components/toast";
import { AppGroupDomainPreflight } from "./domain-preflight";
import { formatDate, idOf, items, text, useApi } from "../../hooks/use-api";

type Deployment = Record<string, unknown>;
const FINISHED = new Set(["Succeeded", "Failed", "RolledBack", "RollbackFailed", "Cancelled", "Canceled"]);
const PAGE_SIZE = 20;
const active = (row: Deployment) => !FINISHED.has(text(row.status, "Unknown"));
export function deploymentInDateRange(row: Deployment, from: string, to: string) {
  if (!from && !to) return true;
  const timestamp = Date.parse(text(row.createdAt ?? row.updatedAt, ""));
  if (!Number.isFinite(timestamp)) return false;
  const start = from ? Date.parse(from) : NaN;
  const end = to ? Date.parse(to) : NaN;
  return (!from || (Number.isFinite(start) && timestamp >= start)) && (!to || (Number.isFinite(end) && timestamp <= end));
}
export function invalidDeploymentTimeRange(from: string, to: string) {
  if (!from || !to) return false;
  const start = Date.parse(from), end = Date.parse(to);
  return !Number.isFinite(start) || !Number.isFinite(end) || start > end;
}
export function deploymentRollbackReason(row: Deployment, currentVersion: number | null | undefined, busy: boolean) {
  if (text(row.status) !== "Succeeded") return "Rollback requires a successful deployment.";
  if (currentVersion != null && Number(row.version) === currentVersion) return "This deployment is already current.";
  if (busy) return "Wait for the running deployment or operation to finish.";
  return "";
}

export function AppGroupDeployments({
  tenantId, appGroupId, onReload, currentVersion,
}: {
  tenantId: string;
  appGroupId: string;
  onReload: () => Promise<unknown>;
  currentVersion?: number | null;
}) {
  const root = `/api/tenants/${encodeURIComponent(tenantId)}/app-groups/${encodeURIComponent(appGroupId)}`;
  const q = useApi<unknown>(`${root}/deployments`);
  const [note, setNote] = useState("");
  const [working, setWorking] = useState<string>();
  const [selected, setSelected] = useState<Deployment>();
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const events = useApi<unknown>(selected ? `${root}/deployments/${encodeURIComponent(idOf(selected))}/events` : undefined);
  const rows = useMemo(() => items<Deployment>(q.data), [q.data]);
  const inFlight = rows.some(active);
  const previousStatuses = useRef<{ root: string; statuses: Map<string, string> }>({
    root, statuses: new Map(),
  });
  const [syncingGroup, setSyncingGroup] = useState(false);

  useEffect(() => {
    if (previousStatuses.current.root !== root) {
      previousStatuses.current = { root, statuses: new Map() };
    }
    // A successful history refresh may transition one deployment to terminal
    // while other deployments are still running. Refresh the authoritative
    // App Group version on every observed transition, not only when all
    // operations have finished. Do not treat failed history requests as proof.
    if (q.loading || q.error || !q.data) return;
    const previous = previousStatuses.current.statuses;
    const next = new Map(rows.map(row => [idOf(row), text(row.status, "Unknown")]));
    const transitionedToTerminal = rows.some(row => {
      const prior = previous.get(idOf(row));
      return prior !== undefined && !FINISHED.has(prior) && FINISHED.has(text(row.status, "Unknown"));
    });
    previousStatuses.current = { root, statuses: next };
    if (!transitionedToTerminal) return;
    setSyncingGroup(true);
    void onReload().finally(() => setSyncingGroup(false));
  }, [root, rows, q.data, q.loading, q.error, onReload]);

  useEffect(() => {
    if (!inFlight) return;
    let count = 0;
    const handle = window.setInterval(() => {
      count += 1;
      if (count > 120) { window.clearInterval(handle); return; }
      void q.reload();
    }, 2500);
    return () => window.clearInterval(handle);
  }, [inFlight, q.reload]);

  async function deploy() {
    setWorking("deploy");
    try {
      await apiRequest(`${root}/deploy`, {
        method: "POST", headers: { "idempotency-key": crypto.randomUUID() },
        body: note.trim() ? { note: note.trim() } : {},
      });
      setNote("");
      await Promise.all([q.reload(), onReload()]);
      toast.success("Deployment accepted. Track its progress in deployment history.");
    } catch (cause) { toast.errorFrom(cause, "Deployment request failed."); }
    finally { setWorking(undefined); }
  }

  async function rollback(item: Deployment) {
    setWorking(idOf(item));
    try {
      await apiRequest(`${root}/deployments/${encodeURIComponent(idOf(item))}/rollback`, {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: { note: `Rollback to deployment ${text(item.version, idOf(item))}` },
      });
      await Promise.all([q.reload(), onReload()]);
      toast.success("Rollback accepted. Track its progress in deployment history.");
    } catch (cause) { toast.errorFrom(cause, "Rollback request failed."); }
    finally { setWorking(undefined); }
  }

  const invalidRange = invalidDeploymentTimeRange(from, to);
  const filtersActive = Boolean(search || statusFilter !== "all" || from || to);
  const clearFilters = () => { setSearch(""); setStatusFilter("all"); setFrom(""); setTo(""); setPage(1); };
  const filtered = (invalidRange ? [] : rows).filter(row => {
    const status = text(row.status, "Unknown");
    const filterMatches = statusFilter === "all" || status === statusFilter;
    const value = [row.version, row.note, row.status, row.id].map(x => text(x, "")).join(" ").toLowerCase();
    return filterMatches && deploymentInDateRange(row, from, to) && (!search.trim() || value.includes(search.trim().toLowerCase()));
  });
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const visible = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const statuses = Array.from(new Set(rows.map(row => text(row.status, "Unknown")))).sort();
  const activeDeployments = rows.some(active);
  const historyUnverified = Boolean(q.error || q.loading || !q.data);

  return <section className="space-y-4">
    <div>
      <h2 className="text-xl font-semibold">Deployments</h2>
      <p className="mt-1 text-sm text-[#5B6678]">Publish workspace changes, filter deployment history and inspect operation results. An accepted deployment is not yet a successful rollout.</p>
    </div>
    <AppGroupDomainPreflight tenantId={tenantId} appGroupId={appGroupId} />
    <Card className="p-5">
      <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-end">
        <Field label="Deployment note" hint="Optional context for this release.">
          <Textarea className="min-h-20" value={note} onChange={event => setNote(event.target.value)}
            placeholder="Describe the change being deployed."/>
        </Field>
        <Button variant="primary" disabled={Boolean(working) || activeDeployments || historyUnverified} onClick={() => void deploy()}>
          <DeployIcon size={16}/>{working === "deploy" ? "Submitting…" : "Deploy pending changes"}
        </Button>
      </div>
      {historyUnverified ? <p className="mt-3 text-sm text-[#B42318]">Confirm current deployment history before starting another deployment; stale history cannot establish that no operation is running.</p> : null}
      {activeDeployments ? <p className="mt-3 text-sm text-[#8A5800]" role="status">A deployment is running. This history refreshes automatically until a terminal state is observed; another rollout is not available yet.</p> : null}
    </Card>
    <Card className="overflow-hidden">
      <div className="grid gap-3 border-b border-[#E1E7F0] p-4 sm:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_190px_190px_190px]">
        <TextInput aria-label="Search deployments" placeholder="Search version or note" value={search}
          onChange={event => { setSearch(event.target.value); setPage(1); }}/>
        <Select aria-label="Filter deployment status" value={statusFilter}
          onChange={event => { setStatusFilter(event.target.value); setPage(1); }}>
          <option value="all">All statuses</option>
          {statuses.map(status => <option value={status} key={status}>{status}</option>)}
        </Select>
        <TextInput type="datetime-local" aria-label="Deployments from" value={from} onChange={event => { setFrom(event.target.value); setPage(1); }}/>
        <TextInput type="datetime-local" aria-label="Deployments to" value={to} onChange={event => { setTo(event.target.value); setPage(1); }}/>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#E1E7F0] px-4 py-2 text-xs text-[#5B6678]"><span role="status">Showing {filtered.length} of {rows.length} deployments in the loaded history. Older deployments may require another query.</span><Button size="sm" disabled={!filtersActive} onClick={clearFilters}>Clear deployment filters</Button></div>
      {invalidRange ? <p role="alert" className="p-4 text-sm text-[#B42318]">Deployments from must be earlier than or equal to Deployments to. Correct the range to view history.</p> : null}
      {q.error ? <p role="alert" className="p-4 text-sm text-red-700">Deployment history refresh failed. Previously loaded results may be stale; rollback and deployment actions are disabled until refreshed. <Button size="sm" onClick={() => void q.reload()}>Retry</Button></p> : null}
      <DataTable embedded loading={q.loading} columns={[
        { key: "version", label: "Version" }, { key: "status", label: "Status" },
        { key: "note", label: "Note" }, { key: "time", label: "Timestamp" },
        { key: "actions", label: "Actions" },
      ]} rows={visible.map(row => {
        const isCurrent = currentVersion != null && Number(row.version) === currentVersion;
        const rollbackReason = deploymentRollbackReason(row, currentVersion, activeDeployments || syncingGroup || historyUnverified);
        const canRollback = !rollbackReason;
        return { key: idOf(row), cells: {
          version: <strong>{row.version == null ? text(row.name, "—") : `v${text(row.version)}`}{isCurrent ? <span className="ml-2 text-xs font-medium text-[#0F56A7]">Current</span> : null}</strong>,
          status: <StatusText tone={statusTone(row.status)}>{text(row.status, "Unknown")}</StatusText>,
          note: text(row.note, "—"),
          time: formatDate(row.createdAt ?? row.updatedAt),
          actions: <div className="flex flex-wrap justify-end gap-1">
            <Button size="sm" variant="ghost" onClick={() => setSelected(row)}>Inspect</Button>
            <ConfirmActionButton size="sm" triggerVariant="ghost" disabled={Boolean(working) || !canRollback}
              confirmTitle={`Rollback deployment v${text(row.version, idOf(row))}?`}
              confirmDescription="Rollback starts a new deployment from this successful historical version. It changes active workload configuration and must be confirmed."
              confirmLabel={`Rollback to v${text(row.version, idOf(row))}`}
              onConfirm={() => rollback(row)}>Rollback</ConfirmActionButton>
            {!canRollback ? <span className="block text-xs text-[#718096]" role="note">{rollbackReason}</span> : null}
          </div>,
        } };
      })} empty={<EmptyState icon={<HistoryIcon/>} title="No matching deployments"
        description="Change the filters, or deploy the current workspace to create the first version."/>}/>
      {filtered.length > PAGE_SIZE ? <div className="flex items-center justify-between gap-3 border-t p-4 text-sm">
        <span>{(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filtered.length)} of {filtered.length}</span>
        <div className="flex gap-2">
          <Button size="sm" disabled={safePage <= 1} onClick={() => setPage(x => x - 1)}>Previous</Button>
          <Button size="sm" disabled={safePage >= totalPages} onClick={() => setPage(x => x + 1)}>Next</Button>
        </div>
      </div> : null}
    </Card>
    {selected ? <Card className="overflow-hidden">
      <div className="border-b border-[#E1E7F0] px-5 py-4">
        <h3 className="font-semibold">Deployment events</h3>
        <p className="text-xs text-[#718096]">{selected.version == null ? text(selected.name, idOf(selected)) : `Version ${text(selected.version)}`}</p>
      </div>
      <div className="divide-y divide-[#E1E7F0]">
        {events.error ? <p role="alert" className="p-5 text-sm text-red-700">Deployment events unavailable.</p> : events.loading
          ? <p className="p-5 text-sm text-[#5B6678]">Loading events…</p>
          : items<Deployment>(events.data).length ? items<Deployment>(events.data).map(event =>
            <div className="grid gap-1 px-5 py-3 md:grid-cols-[160px_1fr_160px]" key={idOf(event) || `${text(event.type)}-${text(event.createdAt)}`}>
              <strong className="text-[13px]">{text(event.type, "Event")}</strong>
              <span className="text-[13px] text-[#526070]">{text(event.message, text(event.detail, "—"))}</span>
              <span className="text-xs text-[#718096]">{formatDate(event.createdAt)}</span>
            </div>)
          : <p className="p-5 text-sm text-[#5B6678]">No events recorded for this deployment.</p>}
      </div>
    </Card> : null}
  </section>;
}
