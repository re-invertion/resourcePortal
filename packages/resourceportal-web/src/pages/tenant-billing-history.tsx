import { useState } from "react";
import { Button, Card, DataTable } from "../components/design-system";
import { formatCreditAmount, formatPlnAmount } from "../lib/billing-display";
import { exactConsoleDate, relativeConsoleDate } from "../lib/date-display";
import { idOf, items, text, useApi } from "../hooks/use-api";

type Row = Record<string, unknown>;
type Page = { items?: Row[]; nextCursor?: string | null };
type HistoryKind = "transactions" | "usage" | "resourcebot";

export const BILLING_HISTORY_ENDPOINTS = {
  transactions: "/billing/transactions",
  usage: "/billing/usage-records",
  summary: "/billing/usage-summary",
  resourcebot: "/resource-bot/usage",
} as const;

function when(value: unknown) {
  const timestamp = typeof value === "string" ? value : "";
  const exact = exactConsoleDate(timestamp);
  if (exact === "—") return <span>—</span>;
  return <time dateTime={timestamp} title={exact} className="block" aria-label={exact}>
    {relativeConsoleDate(timestamp)} <span className="block text-xs font-normal text-[#718096]">{exact}</span>
  </time>;
}

function amount(value: unknown, unit: "credits" | "PLN") {
  return `${unit === "PLN" ? formatPlnAmount(value) : formatCreditAmount(value)} ${unit}`;
}

export function TenantBillingHistory({ tenantId }: { tenantId: string }) {
  const root = `/api/tenants/${encodeURIComponent(tenantId)}`;
  const [kind, setKind] = useState<HistoryKind>("transactions");
  const [transactionCursors, setTransactionCursors] = useState<string[]>([]);
  const [usageCursors, setUsageCursors] = useState<string[]>([]);
  const cursors = kind === "usage" ? usageCursors : transactionCursors;
  const pathFor = (endpoint: string, history: string[]) => {
    const query = new URLSearchParams({ limit: "25" });
    if (history.length) query.set("cursor", history[history.length - 1]);
    return root + endpoint + "?" + query;
  };
  // All requests remain explicitly tenant-scoped. The API enforces billing.read.
  const transactions = useApi<Page>(pathFor(BILLING_HISTORY_ENDPOINTS.transactions, transactionCursors));
  const usage = useApi<Page>(pathFor(BILLING_HISTORY_ENDPOINTS.usage, usageCursors));
  const summary = useApi<Row>(root + BILLING_HISTORY_ENDPOINTS.summary);
  const resourcebot = useApi<Page>(root + BILLING_HISTORY_ENDPOINTS.resourcebot + "?limit=50");
  const current = kind === "transactions" ? transactions : kind === "usage" ? usage : resourcebot;
  const rows = items<Row>(current.data);
  const nextCursor = kind === "resourcebot" ? undefined : current.data?.nextCursor;
  const next = () => {
    if (!nextCursor) return;
    if (kind === "transactions") setTransactionCursors(v => [...v, nextCursor]);
    if (kind === "usage") setUsageCursors(v => [...v, nextCursor]);
  };
  const previous = () => {
    if (kind === "transactions") setTransactionCursors(v => v.slice(0, -1));
    if (kind === "usage") setUsageCursors(v => v.slice(0, -1));
  };
  return <Card className="overflow-hidden">
    <div className="border-b border-[#E1E7F0] px-5 py-4">
      <h2 className="font-semibold">Billing history and usage details</h2>
      <p className="mt-1 text-sm text-[#5B6678]">Tenant-private read-only history, available only with billing.read. Charges and credits are displayed separately. Platform Admin has no tenant-private finance shortcut.</p>
      <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Billing history category">
        <Button variant={kind === "transactions" ? "primary" : "secondary"} onClick={() => setKind("transactions")}>Transactions</Button>
        <Button variant={kind === "usage" ? "primary" : "secondary"} onClick={() => setKind("usage")}>Usage records</Button>
        <Button variant={kind === "resourcebot" ? "primary" : "secondary"} onClick={() => setKind("resourcebot")}>ResourceBot usage</Button>
      </div>
    </div>
    {summary.error ? <p role="alert" className="px-5 pt-3 text-sm text-[#B42318]">Usage summary unavailable. This is not zero usage.</p> : null}
    {!summary.error && !summary.loading && summary.data ? <p className="px-5 pt-3 text-sm text-[#5B6678]">Usage summary: {amount(summary.data.chargedPln, "PLN")} charged ({amount(summary.data.chargedCredits, "credits")}); theoretical {amount(summary.data.theoreticalCostPln, "PLN")}.</p> : null}
    {current.error ? <div role="alert" className="px-5 py-3 text-sm text-[#B42318]">Billing records could not be loaded. No empty-history conclusion is possible. <Button onClick={() => void current.reload()}>Retry</Button></div> : null}
    {!current.error && <DataTable embedded loading={current.loading} columns={kind === "transactions" ? [
      { key: "name", label: "Transaction" }, { key: "amount", label: "Amount" }, { key: "status", label: "Status" }, { key: "time", label: "Created" },
    ] : kind === "usage" ? [
      { key: "name", label: "Resource" }, { key: "amount", label: "Charged" }, { key: "status", label: "Period" }, { key: "time", label: "Recorded" },
    ] : [
      { key: "name", label: "ResourceBot model" }, { key: "amount", label: "Charged" }, { key: "status", label: "Tokens / status" }, { key: "time", label: "Created" },
    ]} rows={rows.map(r => ({ key: idOf(r), cells: kind === "transactions" ? {
      name: <strong>{text(r.type, "Transaction")}</strong>,
      amount: <span>{amount(r.amountPln, "PLN")}<span className="block text-xs text-[#718096]">{amount(r.amountCredits, "credits")}</span></span>,
      status: text(r.status, "Unknown"),
      time: when(r.createdAt),
    } : kind === "usage" ? {
      name: <span>{text(r.resourceType, "Resource")}<span className="block text-xs text-[#718096]">Usage record</span></span>,
      amount: <span>{amount(r.chargedPln, "PLN")}<span className="block text-xs text-[#718096]">{amount(r.chargedCredits, "credits")}</span></span>,
      status: <span>{when(r.periodStart)} — {when(r.periodEnd)}</span>,
      time: when(r.createdAt),
    } : {
      name: <span>{text(r.model, "Unknown model")}<span className="block text-xs text-[#718096]">{text(r.provider, "Provider unavailable")}</span></span>,
      amount: amount(r.chargedCredits, "credits"),
      status: <span>{text(r.totalTokens, "—")} tokens · {text(r.status, "Unknown")}</span>,
      time: when(r.createdAt),
    } }))} />}
    {!current.error && !current.loading && rows.length === 0 ? <p className="px-5 py-3 text-sm text-[#5B6678]">No records in this loaded history page.</p> : null}
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#E1E7F0] px-5 py-3 text-sm text-[#5B6678]">
      <span>{kind === "resourcebot" ? "The API returns at most the 50 latest ResourceBot records; older history cannot be browsed here." : `Page ${cursors.length + 1}, up to 25 records. More pages are available only when the API returns nextCursor.`}</span>
      {kind !== "resourcebot" ? <div className="flex gap-2"><Button disabled={cursors.length === 0 || current.loading} onClick={previous}>Previous</Button><Button disabled={!nextCursor || current.loading} onClick={next}>Next</Button></div> : null}
    </div>
  </Card>;
}
