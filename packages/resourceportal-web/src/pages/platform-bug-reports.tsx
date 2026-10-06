import { useMemo, useState } from "react";
import { apiRequest } from "../api/client";
import {
  BugIcon,
  Button,
  Callout,
  Card,
  Dialog,
  EmptyState,
  Field,
  MetricFilterCard,
  PageHeader,
  Select,
  StatusBadge,
  Textarea,
} from "../components/design-system";
import { toast } from "../components/toast";
import { formatDate, useApi } from "../hooks/use-api";

type Priority = "P0" | "P1" | "P2" | "P3";
type ResolutionFilter = "all" | "open" | "resolved";

type BugReport = {
  id: string;
  description: string;
  priority: Priority;
  resolved: boolean;
  resolvedAt: string | null;
  resolutionNote: string | null;
  url: string | null;
  reporter: { id: string; email: string; displayName: string };
  hasImage: boolean;
  imageUrl: string | null;
  imageFileName: string | null;
  createdAt: string;
  updatedAt: string;
};

const priorityMeta: Record<
  Priority,
  { label: string; tone: "danger" | "warning" | "info" | "neutral" }
> = {
  P0: { label: "Critical", tone: "danger" },
  P1: { label: "High", tone: "warning" },
  P2: { label: "Normal", tone: "info" },
  P3: { label: "Low", tone: "neutral" },
};

const resolutionLabel: Record<ResolutionFilter, string> = {
  all: "All statuses",
  open: "Open",
  resolved: "Resolved",
};

export function PlatformBugReportsPage() {
  const reports = useApi<BugReport[]>("/api/platform/bug-reports", []);
  const [filter, setFilter] = useState<"all" | Priority>("all");
  const [resolutionFilter, setResolutionFilter] =
    useState<ResolutionFilter>("open");
  const [working, setWorking] = useState<string>();
  const [resolutionTarget, setResolutionTarget] = useState<BugReport>();
  const [resolutionNote, setResolutionNote] = useState("");

  const visible = useMemo(
    () =>
      (reports.data ?? []).filter((report) => {
        const priorityMatches = filter === "all" || report.priority === filter;
        const resolutionMatches =
          resolutionFilter === "all" ||
          (resolutionFilter === "resolved"
            ? report.resolved
            : !report.resolved);
        return priorityMatches && resolutionMatches;
      }),
    [reports.data, filter, resolutionFilter],
  );

  const counts = useMemo(
    () =>
      Object.fromEntries(
        (["P0", "P1", "P2", "P3"] as Priority[]).map((priority) => [
          priority,
          (reports.data ?? []).filter((item) =>
            item.priority === priority &&
            (resolutionFilter === "all" ||
              (resolutionFilter === "resolved" ? item.resolved : !item.resolved)),
          ).length,
        ]),
      ) as Record<Priority, number>,
    [reports.data, resolutionFilter],
  );

  const resolutionCounts = useMemo(
    () => ({
      open: (reports.data ?? []).filter((report) => !report.resolved).length,
      resolved: (reports.data ?? []).filter((report) => report.resolved).length,
    }),
    [reports.data],
  );

  async function setPriority(report: BugReport, priority: Priority) {
    if (priority === report.priority) return;
    setWorking(report.id);
    try {
      await apiRequest(
        `/api/platform/bug-reports/${encodeURIComponent(report.id)}/priority`,
        { method: "PATCH", body: { priority } },
      );
      await reports.reload();
      toast.success(`Bug report priority changed to ${priority}.`);
    } catch (cause) {
      toast.errorFrom(cause, "Bug report priority could not be changed.");
    } finally {
      setWorking(undefined);
    }
  }

  async function setResolved(
    report: BugReport,
    resolved: boolean,
    note?: string,
  ) {
    if (resolved === report.resolved) return;
    setWorking(report.id);
    try {
      await apiRequest(
        `/api/platform/bug-reports/${encodeURIComponent(report.id)}/resolution`,
        { method: "PATCH", body: { resolved, resolutionNote: resolved ? note?.trim() : undefined } },
      );
      await reports.reload();
      setResolutionTarget(undefined);
      setResolutionNote("");
      toast.success(
        resolved ? "Bug report marked as resolved." : "Bug report reopened.",
      );
    } catch (cause) {
      toast.errorFrom(
        cause,
        resolved
          ? "Bug report could not be marked as resolved."
          : "Bug report could not be reopened.",
      );
    } finally {
      setWorking(undefined);
    }
  }

  const activeFilterDescription =
    filter === "all"
      ? resolutionLabel[resolutionFilter]
      : `${filter} · ${priorityMeta[filter].label} · ${resolutionLabel[resolutionFilter]}`;

  return (
    <main>
      <PageHeader
        eyebrow="Platform Admin"
        title="Bug reports"
        description="Review issues submitted from the ResourcePortal top bar, assign operational priority and track whether each issue is open or resolved."
        actions={
          <Button
            onClick={() => void reports.reload()}
            disabled={reports.loading}
          >
            Refresh
          </Button>
        }
      />
      {reports.error ? (
        <Callout tone="danger" title="Bug reports unavailable">
          {reports.error instanceof Error
            ? reports.error.message
            : "The bug report API could not be loaded."}
        </Callout>
      ) : null}

      <div
        className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5"
        aria-label="Bug report statistics and priority filters"
      >
        <MetricFilterCard
          label="All reports"
          value={resolutionFilter === "all" ? (reports.data ?? []).length : resolutionFilter === "open" ? resolutionCounts.open : resolutionCounts.resolved}
          detail={resolutionFilter === "all" ? "Total submitted" : resolutionFilter === "open" ? "Open reports" : "Resolved reports"}
          icon={<BugIcon size={17} />}
          active={filter === "all"}
          onClick={() => setFilter("all")}
        />
        {(["P0", "P1", "P2", "P3"] as Priority[]).map((priority) => (
          <MetricFilterCard
            key={priority}
            label={priority}
            value={counts[priority]}
            detail={priorityMeta[priority].label}
            tone={priorityMeta[priority].tone}
            active={filter === priority}
            onClick={() => setFilter(priority)}
          />
        ))}
      </div>

      <div
        className="mb-6 flex flex-wrap items-center gap-2"
        role="group"
        aria-label="Bug report resolution filter"
      >
        <span className="mr-1 text-xs font-semibold uppercase tracking-[.05em] text-[#718096]">
          Status
        </span>
        {(["all", "open", "resolved"] as ResolutionFilter[]).map((status) => {
          const count =
            status === "all"
              ? (reports.data ?? []).length
              : resolutionCounts[status];
          return (
            <Button
              key={status}
              size="sm"
              variant={resolutionFilter === status ? "primary" : "secondary"}
              aria-pressed={resolutionFilter === status}
              onClick={() => setResolutionFilter(status)}
            >
              {resolutionLabel[status]} · {count}
            </Button>
          );
        })}
      </div>

      <Card className="overflow-hidden">
        <div className="flex flex-col justify-between gap-2 border-b border-[#E1E7F0] px-5 py-4 sm:flex-row sm:items-center">
          <div>
            <h2 className="font-semibold text-[#172033]">Submitted reports</h2>
            <p className="mt-0.5 text-xs text-[#718096]">
              {activeFilterDescription}
            </p>
          </div>
          {filter !== "all" ? (
            <button
              type="button"
              className="text-sm font-semibold text-[#0F56A7] hover:underline"
              onClick={() => setFilter("all")}
            >
              Clear priority filter
            </button>
          ) : null}
        </div>

        {reports.loading && !reports.data?.length ? (
          <div className="px-5 py-10 text-center text-sm text-[#718096]">
            Loading bug reports…
          </div>
        ) : visible.length ? (
          <div className="divide-y divide-[#E1E7F0]">
            {visible.map((report) => (
              <article key={report.id} className="p-5">
                <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_210px]">
                  <div className="min-w-0">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <StatusBadge tone={priorityMeta[report.priority].tone}>
                        {report.priority} ·{" "}
                        {priorityMeta[report.priority].label}
                      </StatusBadge>
                      <StatusBadge tone={report.resolved ? "success" : "info"}>
                        {report.resolved ? "Resolved" : "Open"}
                      </StatusBadge>
                      <span className="text-xs text-[#718096]">
                        Submitted {formatDate(report.createdAt)}
                      </span>
                      {report.resolvedAt ? (
                        <span className="text-xs text-[#718096]">
                          Resolved {formatDate(report.resolvedAt)}
                        </span>
                      ) : null}
                    </div>

                    <p className="whitespace-pre-wrap break-words text-sm leading-6 text-[#263449]">
                      {report.description}
                    </p>

                    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-[#718096]">
                      <span>
                        Reporter:{" "}
                        <strong className="font-medium text-[#42526B]">
                          {report.reporter.displayName || report.reporter.email}
                        </strong>
                      </span>
                      {report.reporter.email ? (
                        <span>{report.reporter.email}</span>
                      ) : null}
                      {report.url ? (
                        <a
                          href={report.url}
                          target="_blank"
                          rel="noreferrer"
                          className="max-w-full truncate font-semibold text-[#0F56A7] hover:underline"
                        >
                          Open reported URL
                        </a>
                      ) : null}
                      {report.hasImage && report.imageUrl ? (
                        <a
                          href={report.imageUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 font-semibold text-[#0F56A7] hover:underline"
                        >
                          <BugIcon size={14} />
                          Open image
                          {report.imageFileName
                            ? ` · ${report.imageFileName}`
                            : ""}
                        </a>
                      ) : null}
                    </div>
                    {report.resolved && report.resolutionNote ? (
                      <div className="mt-4 rounded-lg border border-[#CDE7D3] bg-[#F3FBF5] p-3">
                        <p className="text-xs font-semibold uppercase tracking-[.04em] text-[#287A3E]">Resolution</p>
                        <p className="mt-1 whitespace-pre-wrap text-sm leading-5 text-[#355B40]">{report.resolutionNote}</p>
                      </div>
                    ) : null}
                  </div>

                  <div className="min-w-0 space-y-3">
                    <div>
                      <label
                        className="block text-xs font-medium text-[#526070]"
                        htmlFor={`priority-${report.id}`}
                      >
                        Priority
                      </label>
                      <Select
                        id={`priority-${report.id}`}
                        aria-label={`Priority for bug report ${report.id}`}
                        className="mt-1"
                        value={report.priority}
                        disabled={working === report.id}
                        onChange={(event) =>
                          void setPriority(
                            report,
                            event.target.value as Priority,
                          )
                        }
                      >
                        <option value="P0">P0 — Critical</option>
                        <option value="P1">P1 — High</option>
                        <option value="P2">P2 — Normal</option>
                        <option value="P3">P3 — Low</option>
                      </Select>
                    </div>

                    <Button
                      className="w-full"
                      variant={report.resolved ? "secondary" : "primary"}
                      disabled={working === report.id}
                      onClick={() => {
                        if (report.resolved) void setResolved(report, false);
                        else { setResolutionTarget(report); setResolutionNote(""); }
                      }}
                    >
                      {working === report.id
                        ? "Saving…"
                        : report.resolved
                          ? "Reopen"
                          : "Mark as resolved"}
                    </Button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="p-6">
            <EmptyState
              icon={<BugIcon />}
              title="No bug reports"
              description="No bug reports match the current priority and status filters."
            />
          </div>
        )}
      </Card>
      <Dialog
        open={Boolean(resolutionTarget)}
        onClose={() => { if (!working) { setResolutionTarget(undefined); setResolutionNote(""); } }}
        title="Resolve bug report"
        description="Describe what was changed so the resolution remains useful in the bug history."
        actions={<>
          <Button variant="secondary" disabled={Boolean(working)} onClick={() => { setResolutionTarget(undefined); setResolutionNote(""); }}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!resolutionTarget || Boolean(working) || !resolutionNote.trim()}
            onClick={() => resolutionTarget ? void setResolved(resolutionTarget, true, resolutionNote) : undefined}
          >
            {working ? "Saving…" : "Mark as resolved"}
          </Button>
        </>}
      >
        <Field label="Resolution description" required hint="Summarize the implementation, fix or operational action that resolved this report.">
          <Textarea
            aria-label="Resolution description"
            rows={6}
            maxLength={4000}
            value={resolutionNote}
            onChange={(event) => setResolutionNote(event.target.value)}
          />
        </Field>
      </Dialog>
    </main>
  );
}