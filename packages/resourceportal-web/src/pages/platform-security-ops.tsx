import { useState } from "react";
import { apiRequest } from "../api/client";
import {
  Button, Callout, Card, ConfirmActionButton, DetailList, EmptyState,
  PageHeader, StatusBadge, Tabs, TextInput,
} from "../components/design-system";
import { toast } from "../components/toast";
import { formatDate, items, useApi } from "../hooks/use-api";

type Section = "security" | "operations" | "audit" | "worker";
type PlatformOperation = {
  id: string; tenantId: string | null; type: string; status: string;
  resourceType: string; resourceId: string | null; phase: string | null;
  attempt: number; maxAttempts: number; errorCode: string | null;
  errorMessage: string | null; createdAt: string; startedAt: string | null;
  completedAt: string | null;
};
type OperationEvent = {
  id: string; operationId: string; event: string; message: string;
  level: string; timestamp: string; phase: string | null;
};
type AuditEntry = {
  id: string; tenantId?: string | null; action: string; actor: string;
  resourceType: string; resourceId?: string | null;
  result: string; timestamp: string; actorName?: string;
};
type AuditPage = { items: AuditEntry[]; nextCursor: string | null };
type WorkerDiagnostics = {
  generatedAt: string;
  staleAfterSeconds: number;
  workers: Array<{
    workerId: string; status: string; healthy: boolean;
    heartbeatAt: string; lastLoopAt: string | null; lastError: string | null;
    lastOperationStatus: string | null;
  }>;
  reconciliations: Array<{
    workerId: string; key: string; lastSuccessAt: string | null;
    lastFailureAt: string | null; lastCompletedAt: string | null;
    lastDurationMs: number | null; lastError: string | null;
  }>;
};
function reconciliationFailed(item: WorkerDiagnostics["reconciliations"][number]) {
  return Boolean(item.lastFailureAt && (!item.lastSuccessAt ||
    new Date(item.lastFailureAt).getTime() > new Date(item.lastSuccessAt).getTime()));
}
const tabs: Array<{ label: string; href: string; activeFor: Section }> = [
  { label: "Security", href: "/platform/security", activeFor: "security" },
  { label: "Operations", href: "/platform/operations", activeFor: "operations" },
  { label: "Audit log", href: "/platform/audit", activeFor: "audit" },
  { label: "Workers", href: "/platform/worker", activeFor: "worker" },
];

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "The platform service is unavailable.";
}
function Status({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  const tone = ["succeeded", "healthy", "ok", "active"].includes(normalized) ? "success"
    : ["failed", "rollbackfailed", "degraded", "error"].includes(normalized) ? "danger"
    : ["running", "pending", "rollingback", "stale"].includes(normalized) ? "warning" : "neutral";
  return <StatusBadge tone={tone}>{status}</StatusBadge>;
}
function ErrorNotice({ error, retry, label }: { error: unknown; retry: () => void; label: string }) {
  return <Callout tone="danger" title={label} action={<Button size="sm" onClick={retry}>Retry</Button>}>{errorText(error)}</Callout>;
}

function PlatformOperations() {
  const operations = useApi<PlatformOperation[]>("/api/platform/operations", []);
  const [selectedId, setSelectedId] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const detail = useApi<PlatformOperation>(selectedId ? `/api/platform/operations/${encodeURIComponent(selectedId)}` : undefined);
  const events = useApi<OperationEvent[]>(selectedId ? `/api/platform/operations/${encodeURIComponent(selectedId)}/events` : undefined, []);
  const platformItems = !operations.loading && !operations.error
    ? items<PlatformOperation>(operations.data).filter((item) => item.tenantId === null) : [];
  // The server enforces tenantId IS NULL. UI also refuses to display anything
  // returned outside that scope, including a stale detail response.
  const operation = !detail.loading && !detail.error && detail.data?.tenantId === null &&
    detail.data.id === selectedId ? detail.data : undefined;
  const safeEvents = !events.loading && !events.error
    ? (events.data ?? []).filter(event => event.operationId === selectedId) : [];
  const retryable = operation && ["Failed", "RollbackFailed"].includes(operation.status)
    && !["APP_GROUP_DEPLOY", "APP_GROUP_ROLLBACK"].includes(operation.type);
  async function retry() {
    if (!operation || !retryable || submitting) return;
    setSubmitting(true);
    try {
      await apiRequest(`/api/platform/operations/${encodeURIComponent(operation.id)}/retry`, { method: "POST" });
      await Promise.all([operations.reload(), detail.reload(), events.reload()]);
      toast.success("Platform operation retry requested.");
    } catch (error) { toast.errorFrom(error, "Platform operation could not be retried."); }
    finally { setSubmitting(false); }
  }
  return <div className="space-y-5">
    {operations.error ? <ErrorNotice error={operations.error} retry={() => void operations.reload()} label="Platform operations unavailable" /> : null}
    <Card className="p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold text-[#172033]">Platform operations</h2>
        <Button size="sm" disabled={operations.loading} onClick={() => void operations.reload()}>Refresh</Button>
      </div>
      <p className="mt-1 text-xs text-[#5B6678]">The API returns platform-owned operations only. Tenant operations cannot be accessed from here.</p>
      {operations.loading && !operations.data?.length ? <p className="mt-4 text-sm">Loading operations…</p> :
        platformItems.length === 0 ? <EmptyState title="No platform operations" description="No platform-owned operations are available in this record." /> :
        <div className="mt-4 overflow-x-auto"><table className="w-full text-left text-sm">
          <thead><tr className="border-b text-xs text-[#5B6678]"><th className="p-2">Operation</th><th className="p-2">Status</th><th className="p-2">Created</th><th className="p-2">Details</th></tr></thead>
          <tbody>{platformItems.map(row => <tr key={row.id} className="border-b border-[#E1E7F0]">
            <td className="p-2 font-medium">{row.type}</td>
            <td className="p-2"><Status status={row.status} /></td>
            <td className="p-2">{formatDate(row.createdAt)}</td>
            <td className="p-2"><Button size="sm" aria-label={`View platform operation ${row.id}`} onClick={() => setSelectedId(row.id)}>View</Button></td>
          </tr>)}</tbody>
        </table></div>}
    </Card>
    {selectedId ? <Card className="p-5">
      <div className="flex items-center justify-between gap-3"><h2 className="font-semibold">Operation details</h2><Button size="sm" onClick={() => setSelectedId(undefined)}>Close details</Button></div>
      {detail.error ? <ErrorNotice error={detail.error} retry={() => void detail.reload()} label="Operation details unavailable" /> : null}
      {detail.loading ? <p className="mt-3 text-sm">Loading operation details…</p> : operation ? <>
        <div className="mt-4"><DetailList columns={2} items={[
          { label: "Operation ID", value: operation.id },
          { label: "Type", value: operation.type },
          { label: "Status", value: <Status status={operation.status} /> },
          { label: "Phase", value: operation.phase || "—" },
          { label: "Resource", value: operation.resourceType },
          { label: "Attempt", value: `${operation.attempt} / ${operation.maxAttempts}` },
          { label: "Started", value: formatDate(operation.startedAt) },
          { label: "Completed", value: formatDate(operation.completedAt) },
          { label: "Error code", value: operation.errorCode || "—" },
          { label: "Error", value: operation.errorMessage || "—" },
        ]}/></div>
        {retryable ? <div className="mt-4"><ConfirmActionButton disabled={submitting} confirmTitle="Retry failed platform operation?" confirmDescription="This re-queues the selected platform operation; it does not retry tenant or deployment operations." confirmLabel="Request retry" onConfirm={retry}>Retry operation</ConfirmActionButton></div> : null}
        <h3 className="mt-6 font-semibold">Operation events</h3>
        {events.error ? <ErrorNotice error={events.error} retry={() => void events.reload()} label="Operation events unavailable" /> : null}
        {events.loading ? <p className="mt-2 text-sm">Loading events…</p> :
          safeEvents.length === 0 ? <p className="mt-2 text-sm text-[#5B6678]">No operation events recorded.</p> :
          <ol className="mt-3 space-y-3">{safeEvents.map(event => <li key={event.id} className="rounded-md border border-[#D7E0EC] p-3 text-sm"><div className="flex justify-between gap-3"><strong>{event.event}</strong><span>{formatDate(event.timestamp)}</span></div><div className="mt-1 text-xs text-[#5B6678]">{event.message}</div></li>)}</ol>}
      </> : !detail.error ? <Callout tone="warning" title="Operation not available">This record is not a platform-owned operation or was removed.</Callout> : null}
    </Card> : null}
  </div>;
}

function platformAuditQuery(filters: { action: string; actor: string; result: string }, cursor?: string, format?: "csv") {
  const params = new URLSearchParams({ ...(format ? { format } : { limit: "50" }) });
  if (filters.action.trim()) params.set("action", filters.action.trim());
  if (filters.actor.trim()) params.set("actor", filters.actor.trim());
  if (filters.result.trim()) params.set("result", filters.result.trim());
  if (cursor && !format) params.set("cursor", cursor);
  return `/api/platform/audit-log${format ? "/export" : ""}?${params.toString()}`;
}
function PlatformAudit() {
  const [draft, setDraft] = useState({ action: "", actor: "", result: "" });
  const [applied, setApplied] = useState(draft);
  const [cursors, setCursors] = useState<string[]>([]);
  const page = useApi<AuditPage>(platformAuditQuery(applied, cursors.at(-1)));
  const validItems = !page.loading && !page.error
    ? (page.data?.items ?? []).filter(row => row.tenantId === null) : [];
  return <div className="space-y-5">
    <Card className="p-5">
      <h2 className="font-semibold">Platform audit log</h2>
      <p className="mt-1 text-xs text-[#5B6678]">Audit records are limited to `tenantId = null` by the API. Tenant activity is available only through its tenant-scoped endpoint.</p>
      <form className="mt-4 grid gap-3 md:grid-cols-3" onSubmit={e => { e.preventDefault(); setCursors([]); setApplied({ ...draft }); }}>
        <label className="text-sm">Action<TextInput aria-label="Filter platform audit by action" value={draft.action} onChange={e => setDraft({ ...draft, action: e.target.value })}/></label>
        <label className="text-sm">Actor ID<TextInput aria-label="Filter platform audit by actor" value={draft.actor} onChange={e => setDraft({ ...draft, actor: e.target.value })}/></label>
        <label className="text-sm">Result<TextInput aria-label="Filter platform audit by result" value={draft.result} onChange={e => setDraft({ ...draft, result: e.target.value })}/></label>
        <div className="md:col-span-3 flex flex-wrap items-center gap-3">
          <Button type="submit">Apply filters</Button>
          <a href={platformAuditQuery(applied, undefined, "csv")} download="audit-log-platform.csv" className="rounded-md border border-[#B9C5D6] px-3 py-2 text-sm font-semibold text-[#0F56A7]">Export platform CSV</a>
          <Button size="sm" disabled={page.loading} onClick={() => void page.reload()}>Refresh</Button>
        </div>
      </form>
    </Card>
    {page.error ? <ErrorNotice error={page.error} retry={() => void page.reload()} label="Platform audit unavailable" /> : null}
    {page.loading ? <Card className="p-4 text-sm">Loading audit entries…</Card> : <Card className="p-5">
      {validItems.length === 0 ? <EmptyState title="No platform audit records" description="No entries match these filters." /> :
      <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b text-xs text-[#5B6678]"><th className="p-2">Time</th><th className="p-2">Action</th><th className="p-2">Actor</th><th className="p-2">Resource</th><th className="p-2">Result</th></tr></thead><tbody>
        {validItems.map(row => <tr key={row.id} className="border-b border-[#E1E7F0]"><td className="p-2">{formatDate(row.timestamp)}</td><td className="p-2">{row.action}</td><td className="p-2">{row.actorName || row.actor}</td><td className="p-2">{row.resourceType}</td><td className="p-2"><Status status={row.result}/></td></tr>)}
      </tbody></table></div>}
      <div className="mt-4 flex gap-3">
        <Button size="sm" disabled={cursors.length === 0} onClick={() => setCursors(old => old.slice(0, -1))}>Previous page</Button>
        <Button size="sm" disabled={!page.data?.nextCursor} onClick={() => { if (page.data?.nextCursor) setCursors(old => [...old, page.data!.nextCursor!]); }}>Next page</Button>
      </div>
    </Card>}
  </div>;
}

function PlatformWorkers() {
  // This is a PlatformAdminGuard-protected endpoint. Do not replace it with
  // the public aggregate health endpoint or expose raw worker/tenant payloads.
  const diagnostics = useApi<WorkerDiagnostics>("/api/platform/observability/diagnostics");
  const state = !diagnostics.loading && !diagnostics.error ? diagnostics.data : undefined;
  const workerRows = Array.isArray(state?.workers) ? state.workers : [];
  const reconciliationRows = Array.isArray(state?.reconciliations) ? state.reconciliations : [];
  const failures = reconciliationRows.filter(reconciliationFailed);
  const healthy = Boolean(state && workerRows.length > 0 &&
    workerRows.every(row => row.healthy === true) && failures.length === 0);
  return <div className="space-y-5">
    {diagnostics.error ? <ErrorNotice error={diagnostics.error} retry={() => void diagnostics.reload()} label="Worker diagnostics unavailable" /> : null}
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <h2 className="font-semibold">Worker and reconciliation diagnostics</h2>
        <Button size="sm" onClick={() => void diagnostics.reload()} disabled={diagnostics.loading}>Refresh</Button>
      </div>
      <p className="mt-1 text-xs text-[#5B6678]">
        Platform-only operational diagnostics. Times reflect the last server observation, not browser activity.
        Tenant operations, environment, secrets and raw reconciliation results are not shown.
      </p>
      {diagnostics.loading ? <p className="mt-4 text-sm">Loading worker diagnostics…</p> : state ? <>
        <div className="mt-4"><DetailList columns={2} items={[
          { label: "Health", value: <Status status={healthy ? "Healthy" : "Degraded"} /> },
          { label: "Workers reported", value: String(workerRows.length) },
          { label: "Active workers", value: String(workerRows.filter(row => row.healthy).length) },
          { label: "Stale or inactive", value: String(workerRows.filter(row => !row.healthy).length) },
          { label: "Failing reconciliations", value: String(failures.length) },
          { label: "Sampled at", value: formatDate(state.generatedAt) },
          { label: "Heartbeat stale threshold", value: String(state.staleAfterSeconds) + " s" },
        ]}/></div>
        {workerRows.length ? <div className="mt-5 overflow-x-auto">
          <h3 className="mb-2 font-semibold">Worker heartbeats</h3>
          <table aria-label="Worker heartbeats" className="w-full text-left text-sm">
            <thead><tr className="border-b text-xs text-[#5B6678]"><th className="p-2">Worker</th><th className="p-2">Health</th><th className="p-2">Heartbeat</th><th className="p-2">Last loop</th><th className="p-2">Last operation</th><th className="p-2">Last error</th></tr></thead>
            <tbody>{workerRows.map(row => <tr key={row.workerId} className="border-b border-[#E1E7F0]">
              <td className="p-2">{row.workerId}</td>
              <td className="p-2"><Status status={row.healthy ? "Healthy" : row.status === "Running" ? "Stale" : row.status} /></td>
              <td className="p-2">{formatDate(row.heartbeatAt)}</td>
              <td className="p-2">{formatDate(row.lastLoopAt)}</td>
              <td className="p-2">{row.lastOperationStatus ?? "—"}</td>
              <td className="p-2 break-words">{row.lastError ?? "—"}</td>
            </tr>)}</tbody>
          </table>
        </div> : <EmptyState title="No workers observed" description="Worker diagnostics have no heartbeat records." />}
        {reconciliationRows.length ? <div className="mt-5 overflow-x-auto">
          <h3 className="mb-2 font-semibold">Reconciliation results</h3>
          <table aria-label="Reconciliation results" className="w-full text-left text-sm">
            <thead><tr className="border-b text-xs text-[#5B6678]"><th className="p-2">Worker</th><th className="p-2">Task</th><th className="p-2">Status</th><th className="p-2">Last completed</th><th className="p-2">Last success</th><th className="p-2">Last failure</th><th className="p-2">Error</th></tr></thead>
            <tbody>{reconciliationRows.map(row => <tr key={row.workerId + ":" + row.key} className="border-b border-[#E1E7F0]">
              <td className="p-2">{row.workerId}</td>
              <td className="p-2">{row.key}</td>
              <td className="p-2"><Status status={reconciliationFailed(row) ? "Failed" : row.lastSuccessAt ? "Succeeded" : "Unknown"}/></td>
              <td className="p-2">{formatDate(row.lastCompletedAt)}</td>
              <td className="p-2">{formatDate(row.lastSuccessAt)}</td>
              <td className="p-2">{formatDate(row.lastFailureAt)}</td>
              <td className="p-2 break-words">{row.lastError ?? "—"}</td>
            </tr>)}</tbody>
          </table>
        </div> : <EmptyState title="No reconciliations reported" description="No worker reconciliation results are available." />}
      </> : !diagnostics.error ? <Callout tone="warning" title="No worker diagnostics">The platform diagnostics endpoint did not return data.</Callout> : null}
      {!healthy && state ? <div className="mt-4"><Callout tone="warning" title="Worker health needs attention">One or more workers are stale/inactive, a reconciliation is failing, or no active worker has reported. Inspect the last heartbeat, loop, and failure details.</Callout></div> : null}
    </Card>
  </div>;
}

export function PlatformSecurityPage({ section = "security" }: { section?: Section }) {
  return <main>
    <PageHeader eyebrow="Platform Admin" title="Security & operations" description="Platform-only operations, audited changes, worker health and mandatory network isolation." />
    <Callout tone="info" title="Tenant security data is private"><span className="block">Tenant data remains tenant-scoped</span><span className="block">Only platform-owned operation and audit records are available here. Tenant activity requires explicit tenant membership and tenant-specific access.</span></Callout>
    <div className="mt-5"><Tabs label="Platform security sections" items={[
      ...tabs.map(tab => ({ label: tab.label, href: tab.href, active: section === tab.activeFor })),
      { label: "Network egress", href: "/platform/network-egress" },
    ]}/></div>
    {section === "security" ? <div className="grid gap-4 md:grid-cols-2">
      {[
        { title: "Operations", detail: "Inspect platform-owned operations, phases and events; confirm eligible failed retries.", href: "/platform/operations" },
        { title: "Audit log", detail: "Filter and export platform security and configuration changes.", href: "/platform/audit" },
        { title: "Worker health", detail: "Inspect per-worker heartbeats, last loops and reconciliation errors.", href: "/platform/worker" },
        { title: "Network egress", detail: "Verify mandatory tenant private-network protection and actual enforcement revision.", href: "/platform/network-egress" },
      ].map(item => <Card key={item.href} className="p-5"><h2 className="font-semibold">{item.title}</h2><p className="mt-2 min-h-11 text-sm text-[#5B6678]">{item.detail}</p><a className="mt-3 inline-block text-sm font-semibold text-[#0F56A7] underline" href={item.href}>Open {item.title}</a></Card>)}
    </div> : section === "operations" ? <PlatformOperations /> : section === "audit" ? <PlatformAudit /> : <PlatformWorkers />}
  </main>;
}
