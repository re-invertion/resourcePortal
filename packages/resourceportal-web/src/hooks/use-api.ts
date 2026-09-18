import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "../api/client";

export function items<T = Record<string, unknown>>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["items", "data", "results"]) if (Array.isArray(record[key])) return record[key] as T[];
  }
  return [];
}

export function useApi<T>(path: string | undefined, initial?: T) {
  const [data, setData] = useState<T | undefined>(initial); const [loading, setLoading] = useState(Boolean(path)); const [error, setError] = useState<unknown>();
  const reload = useCallback(async () => { if (!path) return; setLoading(true); setError(undefined); try { setData(await apiRequest<T>(path)); } catch (cause) { setError(cause); } finally { setLoading(false); } }, [path]);
  useEffect(() => { void reload(); }, [reload]);
  return { data, setData, loading, error, reload };
}

export function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
export function text(value: unknown, fallback = "—") { if (typeof value === "string" && value) return value; if (typeof value === "number" || typeof value === "bigint") return String(value); return fallback; }
export function idOf(value: Record<string, unknown>) { return text(value.id, ""); }
export function numberOf(value: unknown, fallback = 0) { const parsed = typeof value === "number" ? value : Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
export function formatBytes(value: unknown) { const n = numberOf(value, NaN); if (!Number.isFinite(n)) return "—"; if (n < 1024) return `${n} B`; const units = ["KiB","MiB","GiB","TiB"]; let current = n / 1024; let unit = units[0]; for (let i=1; i<units.length && current >= 1024; i++) { current /= 1024; unit = units[i]; } return `${current >= 10 ? current.toFixed(0) : current.toFixed(1)} ${unit}`; }
export function formatDate(value: unknown) { if (typeof value !== "string") return "—"; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined,{dateStyle:"medium",timeStyle:"short"}).format(date); }
