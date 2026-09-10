import type { ReactNode } from "react";

export type StatusTone = "positive" | "warning" | "negative" | "neutral";

export function statusTone(value: string): StatusTone {
  const normalized = value.replace(/[^a-z]/gi, "").toLowerCase();
  if (["healthy", "ready", "running", "succeeded", "success", "active", "insync", "available", "completed", "complete", "valid", "verified"].includes(normalized)) return "positive";
  if (["failed", "error", "unhealthy", "blocked", "suspended", "drifted", "invalid", "disconnected", "removed", "rollbackfailed"].includes(normalized)) return "negative";
  if (["stopped", "pending", "unknown", "degraded", "maintenance", "paused", "validating", "deploying", "rollingback"].includes(normalized)) return "warning";
  return "neutral";
}

export function StatusBadge({ children, tone }: { children: string; tone?: StatusTone }) {
  return <span className="rp-status-pill" data-tone={tone ?? statusTone(children)}>{children}</span>;
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) {
  return <header className="rp-page-hero">
    <div>{eyebrow ? <p className="rp-eyebrow">{eyebrow}</p> : null}<h1>{title}</h1>{description ? <p>{description}</p> : null}</div>
    {actions ? <div className="rp-page-actions">{actions}</div> : null}
  </header>;
}

export function MetricCard({ label, value, detail, loading, error, testId }: { label: string; value: string; detail?: string; loading?: boolean; error?: unknown; testId?: string }) {
  return <article className="rp-dashboard-metric" data-testid={testId}>
    <div className="rp-dashboard-metric-head"><span>{label}</span><span className="rp-dashboard-metric-icon" aria-hidden="true" /></div>
    {loading ? <strong className="rp-dashboard-metric-value">Loading…</strong> : error ? <><strong className="rp-dashboard-metric-value">Unavailable</strong><span>Try the dedicated page for details.</span></> : <><strong className="rp-dashboard-metric-value">{value}</strong>{detail ? <span>{detail}</span> : null}</>}
  </article>;
}

export function Callout({ tone = "info", title, children, action }: { tone?: "info" | "warning" | "danger" | "success"; title: string; children?: ReactNode; action?: ReactNode }) {
  const role = tone === "danger" ? "alert" : "status";
  return <div className="rp-callout" data-tone={tone} role={role}><div><strong>{title}</strong>{children ? <div className="rp-callout-copy">{children}</div> : null}</div>{action ? <div className="rp-callout-action">{action}</div> : null}</div>;
}

export function SectionNav({ label, items }: { label: string; items: Array<{ label: string; href: string }> }) {
  return <nav className="rp-section-nav" aria-label={label}>{items.map((item) => <a href={item.href} key={item.href}>{item.label}</a>)}</nav>;
}
