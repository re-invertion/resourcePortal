import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../api/client";
import { JsonPayloadForm } from "../components/forms";
import { ErrorState, ReadOnlyPanel, ResourcePanel } from "../components/resource";
import {
  correctionForm,
  identityProviderForm,
  infrastructureMaintenanceForm,
  oauthApplicationForm,
  paymentForm,
  platformMaintenanceForm,
  platformServiceIdentityForm,
  priceListForm,
  refundForm,
  voucherForm,
} from "./form-templates";

const enc = encodeURIComponent;
const itemId = (item: Record<string, unknown>) => enc(String(item.id ?? ""));

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function prefill(template: Record<string, unknown>, current: unknown) {
  if (!isRecord(current)) return template;
  return Object.fromEntries(Object.entries(template).map(([key, fallback]) => [key, current[key] === undefined ? fallback : current[key]]));
}

function Action({ label, path }: { label: string; path: string }) {
  const [error, setError] = useState<unknown>();
  const [result, setResult] = useState<unknown>();
  return <section>{error ? <ErrorState error={error} /> : null}<button type="button" onClick={() => { apiRequest(path, { method: "POST" }).then(setResult).catch(setError); }}>{label}</button>{result !== undefined ? <pre>{JSON.stringify(result, null, 2)}</pre> : null}</section>;
}

function Patch({ title, path, initialValue }: { title: string; path: string; initialValue: Record<string, unknown> }) {
  const [current, setCurrent] = useState<unknown>();
  const [error, setError] = useState<unknown>();
  const [result, setResult] = useState<unknown>();
  useEffect(() => { apiRequest(path).then(setCurrent).catch(setError); }, [path]);
  const formValue = useMemo(() => prefill(initialValue, current), [current, initialValue]);
  return <section><ReadOnlyPanel title={title} path={path} />{error ? <ErrorState error={error} /> : null}<JsonPayloadForm initialValue={formValue} submitLabel="Save" onSubmit={async (body) => { try { const saved = await apiRequest(path, { method: "PATCH", body }); setResult(saved); setCurrent(saved); } catch (cause) { setError(cause); throw cause; } }} />{result !== undefined ? <pre>{JSON.stringify(result, null, 2)}</pre> : null}</section>;
}

export function PlatformPage({ section }: { section: string; resourceId?: string }) {
  if (section === "overview") return <main><h1>Platform overview</h1><ReadOnlyPanel title="Health" path="/api/health" /></main>;
  if (section === "maintenance") return <main><h1>Platform maintenance</h1><Patch title="Maintenance state" path="/api/platform/maintenance" initialValue={platformMaintenanceForm} /></main>;
  if (section === "infrastructure") return <Infrastructure />;
  if (section === "identity-providers") return <main><h1>Platform identity providers</h1><ResourcePanel title="Platform identity providers" listPath="/api/platform/identity-providers" createPath="/api/platform/identity-providers" createInitialValue={identityProviderForm} itemPath={(item) => `/api/platform/identity-providers/${itemId(item)}`} /></main>;
  if (section === "credentials") return <Credentials />;
  if (section === "billing") return <PlatformBilling />;
  return <main><h1>Platform page not found</h1><p>Unknown section: {section}</p></main>;
}

function Infrastructure() {
  return <main><h1>Platform infrastructure</h1><ReadOnlyPanel title="Swarm cluster" path="/api/platform/swarm-cluster" /><Action label="Reconcile Swarm cluster" path="/api/platform/swarm-cluster/reconcile" /><ResourcePanel title="Remote locations" listPath="/api/platform/remote-locations" actions={[{ label: "Set maintenance", method: "PATCH", path: (item) => `/api/platform/remote-locations/${itemId(item)}/maintenance`, body: true, initialValue: infrastructureMaintenanceForm }]} /><ResourcePanel title="Storage backends" listPath="/api/platform/storage-backends" actions={[{ label: "Validate", method: "POST", path: (item) => `/api/platform/storage-backends/${itemId(item)}/validate` }, { label: "Set maintenance", method: "PATCH", path: (item) => `/api/platform/storage-backends/${itemId(item)}/maintenance`, body: true, initialValue: infrastructureMaintenanceForm }]} /></main>;
}

function Credentials() {
  const actions = (resource: string) => [{ label: "Rotate credentials", method: "POST" as const, path: (item: Record<string, unknown>) => `/api/platform/${resource}/${itemId(item)}/rotate-credentials`, oneTimeResponse: true }];
  return <main><h1>Platform machine credentials</h1><ResourcePanel title="Platform OAuth applications" listPath="/api/platform/oauth-applications" createPath="/api/platform/oauth-applications" createInitialValue={oauthApplicationForm} itemPath={(item) => `/api/platform/oauth-applications/${itemId(item)}`} actions={actions("oauth-applications")} oneTimeCreateResponse /><ResourcePanel title="Platform service identities" listPath="/api/platform/service-identities" createPath="/api/platform/service-identities" createInitialValue={platformServiceIdentityForm} itemPath={(item) => `/api/platform/service-identities/${itemId(item)}`} actions={actions("service-identities")} oneTimeCreateResponse /></main>;
}

function MutationForm({ title, path, initialValue }: { title: string; path: string; initialValue: Record<string, unknown> }) {
  const [error, setError] = useState<unknown>();
  const [result, setResult] = useState<unknown>();
  return <section><h2>{title}</h2>{error ? <ErrorState error={error} /> : null}<JsonPayloadForm initialValue={initialValue} submitLabel={title} onSubmit={async (body) => { try { setResult(await apiRequest(path, { method: "POST", body })); } catch (cause) { setError(cause); throw cause; } }} />{result !== undefined ? <pre>{JSON.stringify(result, null, 2)}</pre> : null}</section>;
}

function PlatformBilling() {
  return <main><h1>Platform billing administration</h1><ResourcePanel title="Price lists" listPath="/api/platform/billing/price-lists" createPath="/api/platform/billing/price-lists" createInitialValue={priceListForm} /><ResourcePanel title="Vouchers" listPath="/api/platform/billing/vouchers" createPath="/api/platform/billing/vouchers" createInitialValue={voucherForm} actions={[{ label: "Disable", method: "POST", path: (item) => `/api/platform/billing/vouchers/${itemId(item)}/disable` }]} /><MutationForm title="Register payment" path="/api/platform/billing/payments" initialValue={paymentForm} /><MutationForm title="Refund" path="/api/platform/billing/refunds" initialValue={refundForm} /><MutationForm title="Correction" path="/api/platform/billing/corrections" initialValue={correctionForm} /></main>;
}
