import type { ReactNode } from "react";

type Row = Record<string, unknown>;

type Point = {
  id: string;
  timestamp: Date;
  label: string;
  charged: number;
  chargedPln: number;
  theoretical: number;
  billedReplicas: number;
  desiredReplicas: number;
};

function numberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function recordValue(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function timeLabel(value: Date) {
  return new Intl.DateTimeFormat("pl-PL", { hour: "2-digit", minute: "2-digit" }).format(value);
}

function dateTimeLabel(value: Date) {
  return new Intl.DateTimeFormat("pl-PL", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

function pointsFromRows(rows: Row[]): Point[] {
  return rows
    .map((row, index) => {
      const timestamp = new Date(String(row.periodStart ?? row.createdAt ?? ""));
      if (Number.isNaN(timestamp.getTime())) return null;
      const usage = recordValue(row.usage);
      return {
        id: stringValue(row.id, String(index)),
        timestamp,
        label: timeLabel(timestamp),
        charged: numberValue(row.chargedCredits),
        chargedPln: numberValue(row.chargedPln),
        theoretical: numberValue(row.theoreticalCostCredits),
        billedReplicas: numberValue(usage.billedReplicas),
        desiredReplicas: numberValue(usage.desiredReplicas),
      };
    })
    .filter((point): point is Point => point !== null)
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 4 }).format(value);
}

function ChartLegend({ items }: { items: Array<{ label: string; tone: "primary" | "secondary" }> }) {
  return <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[#66758A]">
    {items.map((item) => <span key={item.label} className="inline-flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-full ${item.tone === "primary" ? "bg-[#1769E0]" : "bg-[#8A96A8]"}`} aria-hidden="true" />
      {item.label}
    </span>)}
  </div>;
}

function LineChart({
  points,
  series,
  ariaLabel,
  valueSuffix,
}: {
  points: Point[];
  series: Array<{ key: keyof Pick<Point, "charged" | "theoretical" | "billedReplicas" | "desiredReplicas">; label: string; tone: "primary" | "secondary" }>;
  ariaLabel: string;
  valueSuffix?: string;
}) {
  const width = 720;
  const height = 220;
  const left = 48;
  const right = 18;
  const top = 16;
  const bottom = 34;
  const innerWidth = width - left - right;
  const innerHeight = height - top - bottom;

  const values = points.flatMap((point) => series.map((item) => Number(point[item.key])));
  const rawMax = Math.max(0, ...values);
  const max = rawMax > 0 ? rawMax : 1;
  const x = (index: number) => points.length <= 1 ? left + innerWidth / 2 : left + (index / (points.length - 1)) * innerWidth;
  const y = (value: number) => top + innerHeight - (value / max) * innerHeight;
  const ticks = [0, 0.5, 1].map((factor) => max * factor);
  const first = points[0];
  const middle = points[Math.floor((points.length - 1) / 2)];
  const last = points[points.length - 1];

  const pathFor = (key: typeof series[number]["key"]) =>
    points.map((point, index) => `${index === 0 ? "M" : "L"} ${x(index).toFixed(2)} ${y(Number(point[key])).toFixed(2)}`).join(" ");

  return <div className="min-w-0">
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="block h-auto w-full overflow-visible"
      role="img"
      aria-label={ariaLabel}
      preserveAspectRatio="xMidYMid meet"
    >
      {ticks.map((tick, index) => {
        const yy = y(tick);
        return <g key={index}>
          <line x1={left} x2={width - right} y1={yy} y2={yy} stroke="#E7ECF3" strokeWidth="1" />
          <text x={left - 8} y={yy + 4} textAnchor="end" fontSize="10" fill="#8A96A8">
            {formatNumber(tick)}{valueSuffix ?? ""}
          </text>
        </g>;
      })}

      {series.map((item) => <path
        key={item.key}
        d={pathFor(item.key)}
        fill="none"
        stroke={item.tone === "primary" ? "#1769E0" : "#8A96A8"}
        strokeWidth={item.tone === "primary" ? 2.5 : 1.8}
        strokeDasharray={item.tone === "secondary" ? "5 5" : undefined}
        strokeLinecap="round"
        strokeLinejoin="round"
      />)}

      {points.map((point, index) => series.map((item) => <circle
        key={`${point.id}-${item.key}`}
        cx={x(index)}
        cy={y(Number(point[item.key]))}
        r={item.tone === "primary" ? 2.8 : 2.2}
        fill={item.tone === "primary" ? "#1769E0" : "#8A96A8"}
      >
        <title>{`${dateTimeLabel(point.timestamp)} · ${item.label}: ${formatNumber(Number(point[item.key]))}${valueSuffix ?? ""}`}</title>
      </circle>))}

      {first ? <text x={left} y={height - 8} textAnchor="start" fontSize="10" fill="#8A96A8">{first.label}</text> : null}
      {middle && points.length > 2 ? <text x={x(Math.floor((points.length - 1) / 2))} y={height - 8} textAnchor="middle" fontSize="10" fill="#8A96A8">{middle.label}</text> : null}
      {last && points.length > 1 ? <text x={width - right} y={height - 8} textAnchor="end" fontSize="10" fill="#8A96A8">{last.label}</text> : null}
    </svg>
  </div>;
}

function SummaryMetric({ label, value, detail }: { label: string; value: ReactNode; detail?: ReactNode }) {
  return <div className="min-w-0">
    <span className="block text-[11px] font-medium uppercase tracking-[0.04em] text-[#8A96A8]">{label}</span>
    <strong className="mt-1 block truncate text-[16px] font-semibold text-[#172033]">{value}</strong>
    {detail ? <span className="mt-0.5 block truncate text-[11px] text-[#718096]">{detail}</span> : null}
  </div>;
}

export function BillingUsageCharts({
  rows,
  loading = false,
  error,
  compact = false,
}: {
  rows: Row[];
  loading?: boolean;
  error?: unknown;
  compact?: boolean;
}) {
  const points = pointsFromRows(rows);
  const totalCharged = points.reduce((sum, point) => sum + point.charged, 0);
  const totalChargedPln = points.reduce((sum, point) => sum + point.chargedPln, 0);
  const totalTheoretical = points.reduce((sum, point) => sum + point.theoretical, 0);
  const peakDesired = Math.max(0, ...points.map((point) => point.desiredReplicas));
  const latest = points.at(-1);
  const first = points[0];
  const last = points[points.length - 1];

  if (loading) {
    return <div className="p-6"><div className="h-48 animate-pulse rounded-lg bg-[#EEF2F7]" /></div>;
  }

  if (error) {
    return <div className="p-6 text-sm text-[#C42B1C]">Usage data could not be loaded.</div>;
  }

  if (!points.length) {
    return <div className="px-6 py-12 text-center">
      <p className="text-sm font-semibold text-[#172033]">No usage samples</p>
      <p className="mt-1 text-xs text-[#718096]">Charts will appear after billable usage records are collected.</p>
    </div>;
  }

  return <div className="min-w-0">
    <div className={`grid gap-4 border-b border-[#E1E7F0] bg-[#F8FAFD] px-5 py-4 ${compact ? "sm:grid-cols-3" : "sm:grid-cols-4"}`}>
      <SummaryMetric label="Samples" value={points.length} />
      <SummaryMetric label="Charged" value={`${formatNumber(totalCharged)} credits`} detail={`${formatNumber(totalChargedPln)} PLN · theoretical ${formatNumber(totalTheoretical)} credits`} />
      <SummaryMetric label="Replica usage" value={latest ? `${formatNumber(latest.billedReplicas)}/${formatNumber(latest.desiredReplicas)} replicas billed` : "—"} detail={`peak desired ${formatNumber(peakDesired)}`} />
      {!compact ? <SummaryMetric label="Period" value={first && last ? `${first.label}–${last.label}` : "—"} detail={last ? dateTimeLabel(last.timestamp) : undefined} /> : null}
    </div>

    <div className={`grid min-w-0 divide-y divide-[#E1E7F0] ${compact ? "" : "xl:grid-cols-2 xl:divide-x xl:divide-y-0"}`}>
      <section className="min-w-0 p-5" aria-label="Credits over time">
        <div className="mb-3 flex flex-col justify-between gap-2 sm:flex-row sm:items-start">
          <div>
            <h3 className="text-sm font-semibold text-[#172033]">Credits over time</h3>
            <p className="mt-0.5 text-xs text-[#718096]">Actual charged credits compared with theoretical cost.</p>
          </div>
          <ChartLegend items={[{ label: "Charged", tone: "primary" }, { label: "Theoretical", tone: "secondary" }]} />
        </div>
        <LineChart
          points={points}
          ariaLabel="Billing credits over time"
          series={[
            { key: "charged", label: "Charged", tone: "primary" },
            { key: "theoretical", label: "Theoretical", tone: "secondary" },
          ]}
        />
      </section>

      <section className="min-w-0 p-5" aria-label="Replica usage over time">
        <div className="mb-3 flex flex-col justify-between gap-2 sm:flex-row sm:items-start">
          <div>
            <h3 className="text-sm font-semibold text-[#172033]">Replica usage</h3>
            <p className="mt-0.5 text-xs text-[#718096]">Billed replicas compared with desired workload replicas.</p>
          </div>
          <ChartLegend items={[{ label: "Billed", tone: "primary" }, { label: "Desired", tone: "secondary" }]} />
        </div>
        <LineChart
          points={points}
          ariaLabel="Billing replica usage over time"
          series={[
            { key: "billedReplicas", label: "Billed replicas", tone: "primary" },
            { key: "desiredReplicas", label: "Desired replicas", tone: "secondary" },
          ]}
        />
      </section>
    </div>
  </div>;
}