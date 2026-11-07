import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../../api/client";
import {
  Button, Card, ConfirmActionButton, DataTable, DeployIcon, EmptyState,
  Field, HistoryIcon, Select, StatusText, Textarea, TextInput, statusTone,
} from "../../components/design-system";
import { toast } from "../../components/toast";
import { formatDate, idOf, items, text, useApi } from "../../hooks/use-api";

type Deployment = Record<string, unknown>;
const FINISHED = new Set(["Succeeded", "Failed", "RolledBack", "RollbackFailed", "Cancelled", "Canceled"]);
const PAGE_SIZE = 20;
const active = (row: Deployment) => !FINISHED.has(text(row.status, "Unknown"));

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
  const [page, setPage] = useState(1);
  const events = useApi<unknown>(selected ? `${root}/deployments/${encodeURIComponent(idOf(selected))}/events` : undefined);
  const rows = useMemo(() => items<Deployment>(q.data), [q.data]);
  const inFlight = rows.some(active);

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

  const filtered = rows.filter(row => {
    const status = text(row.status, "Unknown");
    const filterMatches = statusFilter === "all" || status === statusFilter;
    const value = [row.version, row.note, row.status, row.id].map(x => text(x, "")).join(" ").toLowerCase();
    return filterMatches && (!search.trim() || value.includes(search.trim().toLowerCase()));
  });
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const visible = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const statuses = Array.from(new Set(rows.map(row => text(row.status, "Unknown")))).sort();
  const activeDeployments = rows.some(active);

  return <section className="space-y-4">
    <div>
      <h2 className="text-xl font-semibold">Deployments</h2>
      <p className="mt-1 text-sm text-[#5B6678]">Publish workspace changes, filter deployment history and inspect operation results. An accepted deployment is not yet a successful rollout.</p>
    </div>
    <Card className="p-5">
      <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-end">
        <Field label="Deployment note" hint="Optional context for this release.">
          <Textarea className="min-h-20" value={note} onChange={event => setNote(event.target.value)}
            placeholder="Describe the change being deployed."/>
        </Field>
        <Button variant="primary" disabled={Boolean(working) || activeDeployments} onClick={() => void deploy()}>
          <DeployIcon size={16}/>{working === "deploy" ? "Submitting…" : "Deploy pending changes"}
        </Button>
      </div>
      {activeDeployments ? <p className="mt-3 text-sm text-[#8A5800]" role="status">A deployment is running. This history refreshes automatically until a terminal state is observed; another rollout is not available yet.</p> : null}
    </Card>
    <Card className="overflow-hidden">
      <div className="grid gap-3 border-b border-[#E1E7F0] p-4 sm:grid-cols-[minmax(0,1fr)_190px]">
        <TextInput aria-label="Search deployments" placeholder="Search version or note" value={search}
          onChange={event => { setSearch(event.target.value); setPage(1); }}/>
        <Select aria-label="Filter deployment status" value={statusFilter}
          onChange={event => { setStatusFilter(event.target.value); setPage(1); }}>
          <option value="all">All statuses</option>
          {statuses.map(status => <option value={status} key={status}>{status}</option>)}
        </Select>
      </div>
      {q.error ? <p role="alert" className="p-4 text-sm text-red-700">Deployment history could not be loaded. <Button size="sm" onClick={() => void q.reload()}>Retry</Button></p> : null}
      <DataTable embedded loading={q.loading} columns={[
        { key: "version", label: "Version" }, { key: "status", label: "Status" },
        { key: "note", label: "Note" }, { key: "time", label: "Timestamp" },
        { key: "actions", label: "Actions" },
      ]} rows={visible.map(row => {
        const version = typeof row.version === "number" ? row.version : Number(row.version);
        const isCurrent = currentVersion != null && currentVersion === version;
        const canRollback = text(row.status) === "Succeeded" && !isCurrent && !activeDeployments;
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
            {!canRollback ? <span className="sr-only">Rollback unavailable for non-succeeded, current or in-progress deployment</span> : null}
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
