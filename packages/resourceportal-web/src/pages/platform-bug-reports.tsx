import { useMemo, useState } from "react";
import { apiRequest } from "../api/client";
import { BugIcon, Button, Callout, Card, EmptyState, MetricFilterCard, PageHeader, Select, StatusBadge } from "../components/design-system";
import { toast } from "../components/toast";
import { formatDate, useApi } from "../hooks/use-api";

type Priority = "P0" | "P1" | "P2" | "P3";
type BugReport = {
  id: string;
  description: string;
  priority: Priority;
  reporter: { id: string; email: string; displayName: string };
  hasImage: boolean;
  imageUrl: string | null;
  imageFileName: string | null;
  createdAt: string;
  updatedAt: string;
};

const priorityMeta: Record<Priority, { label: string; tone: "danger" | "warning" | "info" | "neutral" }> = {
  P0: { label: "Critical", tone: "danger" },
  P1: { label: "High", tone: "warning" },
  P2: { label: "Normal", tone: "info" },
  P3: { label: "Low", tone: "neutral" },
};

export function PlatformBugReportsPage() {
  const reports = useApi<BugReport[]>("/api/platform/bug-reports", []);
  const [filter, setFilter] = useState<"all" | Priority>("all");
  const [working, setWorking] = useState<string>();
  const visible = useMemo(() => (reports.data ?? []).filter((report) => filter === "all" || report.priority === filter), [reports.data, filter]);
  const counts = useMemo(() => Object.fromEntries((["P0", "P1", "P2", "P3"] as Priority[]).map((priority) => [priority, (reports.data ?? []).filter((item) => item.priority === priority).length])) as Record<Priority, number>, [reports.data]);

  async function setPriority(report: BugReport, priority: Priority) {
    if (priority === report.priority) return;
    setWorking(report.id);
    try {
      await apiRequest(`/api/platform/bug-reports/${encodeURIComponent(report.id)}/priority`, { method: "PATCH", body: { priority } });
      await reports.reload();
      toast.success(`Bug report priority changed to ${priority}.`);
    } catch (cause) {
      toast.errorFrom(cause, "Bug report priority could not be changed.");
    } finally {
      setWorking(undefined);
    }
  }

  return <main>
    <PageHeader eyebrow="Platform Admin" title="Bug reports" description="Review issues submitted from the ResourcePortal top bar and assign operational priority from P0 (critical) to P3 (low)." actions={<Button onClick={() => void reports.reload()} disabled={reports.loading}>Refresh</Button>} />
    {reports.error ? <Callout tone="danger" title="Bug reports unavailable">{reports.error instanceof Error ? reports.error.message : "The bug report API could not be loaded."}</Callout> : null}

    <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-5" aria-label="Bug report statistics and filters">
      <MetricFilterCard label="All reports" value={(reports.data ?? []).length} detail="Total submitted" icon={<BugIcon size={17}/>} active={filter === "all"} onClick={() => setFilter("all")} />
      {(["P0", "P1", "P2", "P3"] as Priority[]).map((priority) => <MetricFilterCard key={priority} label={priority} value={counts[priority]} detail={priorityMeta[priority].label} tone={priorityMeta[priority].tone} active={filter === priority} onClick={() => setFilter(priority)} />)}
    </div>

    <Card className="overflow-hidden">
      <div className="flex flex-col justify-between gap-2 border-b border-[#E1E7F0] px-5 py-4 sm:flex-row sm:items-center"><div><h2 className="font-semibold text-[#172033]">Submitted reports</h2><p className="mt-0.5 text-xs text-[#718096]">{filter === "all" ? "All priorities" : `${filter} · ${priorityMeta[filter].label}`}</p></div>{filter !== "all" ? <button type="button" className="text-sm font-semibold text-[#0F56A7] hover:underline" onClick={() => setFilter("all")}>Clear filter</button> : null}</div>
      {reports.loading && !(reports.data?.length) ? <div className="px-5 py-10 text-center text-sm text-[#718096]">Loading bug reports…</div> : visible.length ? <div className="divide-y divide-[#E1E7F0]">{visible.map((report) => <article key={report.id} className="p-5">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_180px]">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2"><StatusBadge tone={priorityMeta[report.priority].tone}>{report.priority} · {priorityMeta[report.priority].label}</StatusBadge><span className="text-xs text-[#718096]">Submitted {formatDate(report.createdAt)}</span></div>
            <p className="whitespace-pre-wrap break-words text-sm leading-6 text-[#263449]">{report.description}</p>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-[#718096]"><span>Reporter: <strong className="font-medium text-[#42526B]">{report.reporter.displayName || report.reporter.email}</strong></span>{report.reporter.email ? <span>{report.reporter.email}</span> : null}{report.hasImage && report.imageUrl ? <a href={report.imageUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold text-[#0F56A7] hover:underline"><BugIcon size={14}/>Open image{report.imageFileName ? ` · ${report.imageFileName}` : ""}</a> : null}</div>
          </div>
          <div className="min-w-0">
            <label className="block text-xs font-medium text-[#526070]" htmlFor={`priority-${report.id}`}>Priority</label>
            <Select id={`priority-${report.id}`} aria-label={`Priority for bug report ${report.id}`} className="mt-1" value={report.priority} disabled={working === report.id} onChange={(event) => void setPriority(report, event.target.value as Priority)}>
              <option value="P0">P0 — Critical</option>
              <option value="P1">P1 — High</option>
              <option value="P2">P2 — Normal</option>
              <option value="P3">P3 — Low</option>
            </Select>
          </div>
        </div>
      </article>)}</div> : <div className="p-6"><EmptyState icon={<BugIcon/>} title="No bug reports" description={filter === "all" ? "User-submitted issues will appear here." : `No ${filter} bug reports are currently recorded.`} /></div>}
    </Card>
  </main>;
}
