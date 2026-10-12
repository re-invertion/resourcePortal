// Presentation-only formatting. Never round the stored billing decimal values.
export function formatPlnAmount(value: unknown): string {
  const parsed = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) return "—";
  return new Intl.NumberFormat("pl-PL", {
    minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: true,
  }).format(parsed);
}

export function formatCreditAmount(value: unknown): string {
  const parsed = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) return "—";
  return new Intl.NumberFormat("pl-PL", {
    minimumFractionDigits: 0, maximumFractionDigits: 2, useGrouping: true,
  }).format(parsed);
}

export function quotaDisplay(value: unknown, unit = ""): string {
  if (value === undefined || value === null) return "Not configured";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "Unavailable";
  if (numeric === 0) return unit ? `0 ${unit} (no capacity)` : "0 (no capacity)";
  return `${new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 3 }).format(numeric)}${unit ? " " + unit : ""}`;
}

export function quotaBytesDisplay(value: unknown): string {
  if (value === undefined || value === null) return "Not configured";
  const n = Number(value);
  if (!Number.isFinite(n)) return "Unavailable";
  if (n === 0) return "0 GiB (no capacity)";
  return `${new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 2 }).format(n / 1073741824)} GiB`;
}
