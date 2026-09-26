import { useMemo, useState, type ReactNode } from "react";
import { Checkbox } from "./design-system";

type Row = Record<string, unknown>;

export type BillingUsageRange = "24h" | "7d" | "30d" | "all";

type MetricKey = "charged" | "theoretical" | "billedReplicas" | "desiredReplicas";
type MetricGroup = "credits" | "replicas";

type Point = {
  id: string;
  timestamp: Date;
  charged: number;
  chargedPln: number;
  theoretical: number;
  billedReplicas: number;
  desiredReplicas: number;
};

type Series = {
  key: MetricKey;
  label: string;
  tone: "primary" | "secondary";
};

const RANGE_OPTIONS: Array<{ value: BillingUsageRange; label: string; milliseconds?: number }> = [
  { value: "24h", label: "24h", milliseconds: 24 * 60 * 60 * 1000 },
  { value: "7d", label: "7d", milliseconds: 7 * 24 * 60 * 60 * 1000 },
  { value: "30d", label: "30d", milliseconds: 30 * 24 * 60 * 60 * 1000 },
  { value: "all", label: "All" },
];

const CREDIT_SERIES: Series[] = [
  { key: "charged", label: "Charged", tone: "primary" },
  { key: "theoretical", label: "Theoretical", tone: "secondary" },
];

const REPLICA_SERIES: Series[] = [
  { key: "billedReplicas", label: "Billed replicas", tone: "primary" },
  { key: "desiredReplicas", label: "Desired replicas", tone: "secondary" },
];

export function billingUsageRangeFrom(range: BillingUsageRange, now = new Date()) {
  const option = RANGE_OPTIONS.find((item) => item.value === range);
  if (!option?.milliseconds) return undefined;
  return new Date(now.getTime() - option.milliseconds).toISOString();
}

export function billingUsageBucket(range: BillingUsageRange) {
  switch (range) {
    case "24h":
      return "15m";
    case "30d":
      return "12h";
    case "all":
      return "1d";
    case "7d":
    default:
      return "2h";
  }
}

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

function dateTimeLabel(value: Date) {
  return new Intl.DateTimeFormat("pl-PL", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

function axisLabel(value: Date, spanMs: number) {
  const options: Intl.DateTimeFormatOptions = spanMs > 48 * 60 * 60 * 1000
    ? { day: "2-digit", month: "short" }
    : { hour: "2-digit", minute: "2-digit" };
  return new Intl.DateTimeFormat("pl-PL", options).format(value);
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

function filterPointsByRange(points: Point[], range: BillingUsageRange) {
  const option = RANGE_OPTIONS.find((item) => item.value === range);
  if (!option?.milliseconds || points.length < 2) return points;
  const reference = points.at(-1)?.timestamp.getTime() ?? Date.now();
  const from = reference - option.milliseconds;
  return points.filter((point) => point.timestamp.getTime() >= from);
}

function formatNumber(value: number, maximumFractionDigits = 4) {
  return new Intl.NumberFormat("pl-PL", { maximumFractionDigits }).format(value);
}

function ChartLegend({ items }: { items: Series[] }) {
  return <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[#66758A]">
    {items.map((item) => <span key={item.key} className="inline-flex items-center gap-1.5">
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
  series: Series[];
  ariaLabel: string;
  valueSuffix?: string;
}) {
  const width = 1040;
  const height = 330;
  const left = 58;
  const right = 22;
  const top = 20;
  const bottom = 42;
  const innerWidth = width - left - right;
  const innerHeight = height - top - bottom;

  const values = points.flatMap((point) => series.map((item) => Number(point[item.key])));
  const rawMax = Math.max(0, ...values);
  const max = rawMax > 0 ? rawMax : 1;
  const x = (index: number) => points.length <= 1 ? left + innerWidth / 2 : left + (index / (points.length - 1)) * innerWidth;
  const y = (value: number) => top + innerHeight - (value / max) * innerHeight;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((factor) => max * factor);
  const spanMs = points.length > 1
    ? (points.at(-1)?.timestamp.getTime() ?? 0) - (points[0]?.timestamp.getTime() ?? 0)
    : 0;

  const axisIndexes = [...new Set([
    0,
    Math.floor((points.length - 1) * 0.25),
    Math.floor((points.length - 1) * 0.5),
    Math.floor((points.length - 1) * 0.75),
    points.length - 1,
  ])].filter((index) => index >= 0 && index < points.length);

  const pathFor = (key: MetricKey) =>
    points.map((point, index) => `${index === 0 ? "M" : "L"} ${x(index).toFixed(2)} ${y(Number(point[key])).toFixed(2)}`).join(" ");

  return <div className="min-w-0 overflow-x-auto">
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="block min-w-[680px] w-full overflow-visible"
      role="img"
      aria-label={ariaLabel}
      preserveAspectRatio="xMidYMid meet"
    >
      {ticks.map((tick, index) => {
        const yy = y(tick);
        return <g key={index}>
          <line x1={left} x2={width - right} y1={yy} y2={yy} stroke="#E7ECF3" strokeWidth="1" />
          <text x={left - 10} y={yy + 4} textAnchor="end" fontSize="10" fill="#8A96A8">
            {formatNumber(tick, 3)}{valueSuffix ?? ""}
          </text>
        </g>;
      })}

      {series.map((item) => <path
        key={item.key}
        d={pathFor(item.key)}
        fill="none"
        stroke={item.tone === "primary" ? "#1769E0" : "#8A96A8"}
        strokeWidth={item.tone === "primary" ? 3 : 2}
        strokeDasharray={item.tone === "secondary" ? "6 6" : undefined}
        strokeLinecap="round"
        strokeLinejoin="round"
      />)}

      {points.map((point, index) => series.map((item) => <circle
        key={`${point.id}-${item.key}`}
        cx={x(index)}
        cy={y(Number(point[item.key]))}
        r={item.tone === "primary" ? 3 : 2.6}
        fill={item.tone === "primary" ? "#1769E0" : "#8A96A8"}
      >
        <title>{`${dateTimeLabel(point.timestamp)} · ${item.label}: ${formatNumber(Number(point[item.key]))}${valueSuffix ?? ""}`}</title>
      </circle>))}

      {axisIndexes.map((index) => {
        const point = points[index];
        if (!point) return null;
        return <text
          key={point.id}
          x={x(index)}
          y={height - 10}
          textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"}
          fontSize="10"
          fill="#8A96A8"
        >
          {axisLabel(point.timestamp, spanMs)}
        </text>;
      })}
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

function ToolbarButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    className={`h-8 rounded-md px-3 text-xs font-medium transition ${active
      ? "bg-[#1769E0] text-white shadow-sm"
      : "border border-[#D7E0EC] bg-white text-[#44536A] hover:border-[#AFC7E8] hover:bg-[#F8FAFD]"}`}
  >
    {children}
  </button>;
}

export function BillingUsageCharts({
  rows,
  loading = false,
  error,
  compact = false,
  range,
  onRangeChange,
}: {
  rows: Row[];
  loading?: boolean;
  error?: unknown;
  compact?: boolean;
  range?: BillingUsageRange;
  onRangeChange?: (range: BillingUsageRange) => void;
}) {
  const [internalRange, setInternalRange] = useState<BillingUsageRange>("all");
  const [metricGroup, setMetricGroup] = useState<MetricGroup>("credits");
  const [enabledSeries, setEnabledSeries] = useState<Record<MetricKey, boolean>>({
    charged: true,
    theoretical: true,
    billedReplicas: true,
    desiredReplicas: true,
  });

  const selectedRange = range ?? internalRange;
  const allPoints = useMemo(() => pointsFromRows(rows), [rows]);
  const points = useMemo(() => filterPointsByRange(allPoints, selectedRange), [allPoints, selectedRange]);
  const groupSeries = metricGroup === "credits" ? CREDIT_SERIES : REPLICA_SERIES;
  const visibleSeries = groupSeries.filter((item) => enabledSeries[item.key]);
  const totalCharged = points.reduce((sum, point) => sum + point.charged, 0);
  const totalChargedPln = points.reduce((sum, point) => sum + point.chargedPln, 0);
  const totalTheoretical = points.reduce((sum, point) => sum + point.theoretical, 0);
  const peakDesired = Math.max(0, ...points.map((point) => point.desiredReplicas));
  const peakBilled = Math.max(0, ...points.map((point) => point.billedReplicas));
  const latest = points.at(-1);
  const first = points[0];
  const last = points.at(-1);

  function selectRange(next: BillingUsageRange) {
    if (range === undefined) setInternalRange(next);
    onRangeChange?.(next);
  }

  function toggleSeries(key: MetricKey) {
    const activeKeys = groupSeries.filter((item) => enabledSeries[item.key]);
    if (enabledSeries[key] && activeKeys.length === 1) return;
    setEnabledSeries((current) => ({ ...current, [key]: !current[key] }));
  }

  if (loading) {
    return <div className="p-6"><div className="h-72 animate-pulse rounded-lg bg-[#EEF2F7]" /></div>;
  }

  if (error) {
    return <div className="p-6 text-sm text-[#C42B1C]">Usage data could not be loaded.</div>;
  }

  if (!allPoints.length) {
    return <div className="px-6 py-12 text-center">
      <p className="text-sm font-semibold text-[#172033]">No usage samples</p>
      <p className="mt-1 text-xs text-[#718096]">The chart will appear after billable usage records are collected.</p>
    </div>;
  }

  return <div className="min-w-0">
    {!compact ? <div className="border-b border-[#E1E7F0] bg-[#F8FAFD] px-5 py-4">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Usage time range">
          <span className="mr-1 text-xs font-medium text-[#66758A]">Range</span>
          {RANGE_OPTIONS.map((option) => <ToolbarButton
            key={option.value}
            active={selectedRange === option.value}
            onClick={() => selectRange(option.value)}
          >
            {option.label}
          </ToolbarButton>)}
        </div>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Usage metric">
          <span className="mr-1 text-xs font-medium text-[#66758A]">Metric</span>
          <ToolbarButton active={metricGroup === "credits"} onClick={() => setMetricGroup("credits")}>Credits</ToolbarButton>
          <ToolbarButton active={metricGroup === "replicas"} onClick={() => setMetricGroup("replicas")}>Replicas</ToolbarButton>
        </div>
      </div>
    </div> : null}

    <div className={`grid gap-4 border-b border-[#E1E7F0] bg-white px-5 py-4 ${compact ? "sm:grid-cols-3" : "sm:grid-cols-2 xl:grid-cols-4"}`}>
      <SummaryMetric
        label="Data points"
        value={points.length}
        detail={first && last ? `${dateTimeLabel(first.timestamp)} – ${dateTimeLabel(last.timestamp)}` : undefined}
      />
      <SummaryMetric
        label="Charged"
        value={`${formatNumber(totalCharged)} credits`}
        detail={`${formatNumber(totalChargedPln)} PLN`}
      />
      <SummaryMetric
        label="Theoretical"
        value={`${formatNumber(totalTheoretical)} credits`}
        detail={totalTheoretical > 0 ? `${formatNumber((totalCharged / totalTheoretical) * 100, 1)}% charged` : "No theoretical cost"}
      />
      {!compact ? <SummaryMetric
        label="Replica peak"
        value={`${formatNumber(peakBilled)}/${formatNumber(peakDesired)}`}
        detail={latest ? `latest ${formatNumber(latest.billedReplicas)}/${formatNumber(latest.desiredReplicas)} billed/desired` : undefined}
      /> : null}
    </div>

    <section className="min-w-0 p-5" aria-label={metricGroup === "credits" ? "Credits over time" : "Replica usage over time"}>
      <div className="mb-4 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h3 className="text-sm font-semibold text-[#172033]">
            {metricGroup === "credits" ? "Credits over time" : "Replica usage over time"}
          </h3>
          <p className="mt-0.5 text-xs text-[#718096]">
            {metricGroup === "credits"
              ? "Compare credits actually charged with the theoretical cost for the selected period."
              : "Compare billed replicas with the workload's desired replica count for the selected period."}
          </p>
        </div>
        {!compact ? <div className="flex flex-wrap items-center gap-3" aria-label="Visible chart series">
          {groupSeries.map((item) => <label key={item.key} className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-[#526176]">
            <Checkbox
              checked={enabledSeries[item.key]}
              onChange={() => toggleSeries(item.key)}
              aria-label={`Show ${item.label}`}
            />
            {item.label}
          </label>)}
        </div> : <ChartLegend items={visibleSeries} />}
      </div>

      {points.length ? <LineChart
        points={points}
        ariaLabel={metricGroup === "credits" ? "Billing credits over time" : "Billing replica usage over time"}
        series={visibleSeries}
        valueSuffix={metricGroup === "credits" ? " cr" : undefined}
      /> : <div className="flex min-h-72 items-center justify-center rounded-lg border border-dashed border-[#D7E0EC] bg-[#FBFCFE] px-6 text-center">
        <div>
          <p className="text-sm font-semibold text-[#172033]">No samples in this range</p>
          <p className="mt-1 text-xs text-[#718096]">Choose a wider range to see earlier usage records.</p>
        </div>
      </div>}

      {!compact && points.length ? <div className="mt-3 flex flex-col gap-2 border-t border-[#EEF2F7] pt-3 sm:flex-row sm:items-center sm:justify-between">
        <ChartLegend items={visibleSeries} />
        <p className="text-[11px] text-[#8A96A8]">
          {points.length} point{points.length === 1 ? "" : "s"} · hover a point for its exact value
        </p>
      </div> : null}
    </section>
  </div>;
}
