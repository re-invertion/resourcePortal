import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, apiRequest } from "../api/client";
import { ConfirmButton, JsonPayloadForm, OneTimeCredential, type ReferenceOptions } from "./forms";

type FormTemplate = Record<string, unknown>;

export type ResourceAction = {
  label: string;
  method: "POST" | "PATCH" | "DELETE";
  path: (item: Record<string, unknown>) => string;
  body?: boolean;
  initialValue?: FormTemplate;
  destructive?: boolean;
  permission?: string;
  oneTimeResponse?: boolean;
};

export type ResourcePanelProps = {
  title: string;
  listPath: string;
  createPath?: string;
  itemPath?: (item: Record<string, unknown>) => string;
  deletePath?: (item: Record<string, unknown>) => string;
  detailHref?: (item: Record<string, unknown>) => string;
  createInitialValue?: FormTemplate;
  updateInitialValue?: FormTemplate | ((item: Record<string, unknown>) => FormTemplate);
  createPermission?: string;
  updatePermission?: string;
  deletePermission?: string;
  oneTimeCreateResponse?: boolean;
  actions?: ResourceAction[];
  permissions?: string[];
  help?: string;
  referenceOptionSources?: Record<string, string>;
};

function allowed(permissions: string[] | undefined, permission: string | undefined) {
  if (!permission || !permissions) return true;
  return permissions.includes("*") || permissions.includes(permission);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function extractItems(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item));
  if (isRecord(payload)) {
    for (const key of ["items", "records", "data", "results"]) {
      if (Array.isArray(payload[key])) return extractItems(payload[key]);
    }
    return [payload];
  }
  return [];
}

function optionLabel(item: Record<string, unknown>) {
  for (const key of ["displayName", "name", "email", "rootDomain", "host", "id"]) {
    if (typeof item[key] === "string" && item[key]) return String(item[key]);
  }
  return String(item.id ?? "Unknown resource");
}

function inferredReferenceOptionSources(listPath: string) {
  const tenant = listPath.match(/^(\/api\/tenants\/[^/]+)/)?.[1];
  if (!tenant) return {};
  const sources: Record<string, string> = {};
  if (/\/app-groups\/[^/]+\/single-apps$/.test(listPath)) sources.registryId = `${tenant}/registries`;
  if (/\/(memberships|invitations|service-identities)$/.test(listPath)) sources.roleIds = `${tenant}/roles`;
  if (/\/domains$/.test(listPath)) sources.customRootDomainId = `${tenant}/domains/custom-root-domains`;
  return sources;
}

function fieldLabel(key: string) {
  if (key.toLowerCase() === "id") return "ID";
  const spaced = key
    .replace(/Ids\b/g, " IDs")
    .replace(/Id\b/g, " ID")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .trim();
  if (!spaced) return "Value";
  return spaced.split(/\s+/).map((word, index) => {
    if (word === "ID" || word === "IDs") return word;
    const normalized = word.toLowerCase();
    return index === 0 ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : normalized;
  }).join(" ");
}

function isIsoDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) && !Number.isNaN(Date.parse(value));
}

function statusTone(value: string) {
  const normalized = value.replace(/[^a-z]/gi, "").toLowerCase();
  if (["healthy", "ready", "active", "running", "succeeded", "success", "valid", "verified", "insync", "available", "completed", "complete"].includes(normalized)) return "positive";
  if (["pending", "degraded", "unknown", "warning", "validating", "deploying", "rollingback", "maintenance", "paused", "stopped"].includes(normalized)) return "warning";
  if (["failed", "error", "unhealthy", "down", "invalid", "blocked", "suspended", "disconnected", "removed", "rollbackfailed"].includes(normalized)) return "negative";
  return "neutral";
}

function isStatusField(key: string | undefined) {
  return !!key && /(status|health|state|phase|result|drift)$/i.test(key);
}

function PrimitiveValue({ fieldKey, value }: { fieldKey?: string; value: string | number | boolean | null | undefined }) {
  if (value == null || value === "") return <span className="rp-data-muted">Not set</span>;
  if (typeof value === "boolean") return <span>{value ? "Yes" : "No"}</span>;
  if (typeof value === "number") return <span>{value.toLocaleString("en-US")}</span>;
  if (isStatusField(fieldKey)) return <span className="rp-status-pill" data-tone={statusTone(value)}>{value}</span>;
  if (isIsoDate(value)) {
    const formatted = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(value));
    return <time dateTime={value}>{formatted} UTC</time>;
  }
  if (fieldKey && /(^id$|Id$|Ids$)/.test(fieldKey)) return <code>{value}</code>;
  return <span>{value}</span>;
}

function StructuredValue({ value, fieldKey }: { value: unknown; fieldKey?: string }): React.ReactNode {
  if (value == null || ["string", "number", "boolean"].includes(typeof value)) {
    return <PrimitiveValue fieldKey={fieldKey} value={value as string | number | boolean | null | undefined} />;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="rp-data-muted">None</span>;
    if (value.every((item) => item == null || ["string", "number", "boolean"].includes(typeof item))) {
      return <ul className="rp-data-chip-list">{value.map((item, index) => <li key={index}><PrimitiveValue fieldKey={fieldKey} value={item as string | number | boolean | null | undefined} /></li>)}</ul>;
    }
    return <div className="rp-data-card-list">{value.map((item, index) => <article className="rp-data-card" key={index}>{isRecord(item) ? <ObjectFields value={item} /> : <StructuredValue value={item} />}</article>)}</div>;
  }
  if (isRecord(value)) return <ObjectFields value={value} />;
  return <span>{String(value)}</span>;
}

function ObjectFields({ value, hiddenKeys = [] }: { value: Record<string, unknown>; hiddenKeys?: string[] }) {
  const hidden = new Set(hiddenKeys);
  const entries = Object.entries(value).filter(([key]) => !hidden.has(key));
  const scalar = entries.filter(([, item]) => item == null || ["string", "number", "boolean"].includes(typeof item));
  const nested = entries.filter(([, item]) => !(item == null || ["string", "number", "boolean"].includes(typeof item)));
  if (entries.length === 0) return <p className="rp-data-muted">No additional details.</p>;
  return <div className="rp-data-object">
    {scalar.length ? <dl className="rp-data-grid">{scalar.map(([key, item]) => <div className="rp-data-field" key={key}><dt>{fieldLabel(key)}</dt><dd><StructuredValue fieldKey={key} value={item} /></dd></div>)}</dl> : null}
    {nested.map(([key, item]) => <section className="rp-data-nested" key={key} aria-label={fieldLabel(key)}><h3>{fieldLabel(key)}</h3><StructuredValue fieldKey={key} value={item} /></section>)}
  </div>;
}

export function ReadableDataView({ value, hiddenKeys = [], technicalJson = true }: { value: unknown; hiddenKeys?: string[]; technicalJson?: boolean }) {
  return <div className="rp-readable-data">
    {isRecord(value) ? <ObjectFields value={value} hiddenKeys={hiddenKeys} /> : <StructuredValue value={value} />}
    {technicalJson && value != null && typeof value === "object" ? <details className="rp-technical-json"><summary>Technical JSON</summary><pre>{JSON.stringify(value, null, 2)}</pre></details> : null}
  </div>;
}

function patchTemplate(props: ResourcePanelProps, item: Record<string, unknown>) {
  const configured = typeof props.updateInitialValue === "function"
    ? props.updateInitialValue(item)
    : props.updateInitialValue ?? props.createInitialValue;
  if (!configured) return undefined;
  return Object.fromEntries(Object.entries(configured).map(([key, fallback]) => [key, item[key] === undefined ? fallback : item[key]]));
}

export function ErrorState({ error }: { error: unknown }) {
  if (!(error instanceof ApiError)) return <p role="alert">{error instanceof Error ? error.message : "Request failed"}</p>;
  if (error.status === 401) return <p role="alert">Session expired. <a href="/login">Sign in again</a>.</p>;
  if (error.status === 403) return <p role="alert">Access denied{error.code ? ` (${error.code})` : ""}.</p>;
  if (error.status === 429) return <p role="alert">Too many requests. Retry later.</p>;
  if (error.status === 503) return <p role="alert">Resource Portal is temporarily unavailable or in maintenance.</p>;
  return (
    <div role="alert">
      <p>{error.message}{error.code ? ` (${error.code})` : ""}</p>
      {error.requestId ? <p>requestId: <code>{error.requestId}</code></p> : null}
      {error.correlationId ? <p>correlationId: <code>{error.correlationId}</code></p> : null}
    </div>
  );
}

export function ResourcePanel(props: ResourcePanelProps) {
  const [payload, setPayload] = useState<unknown>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  const [oneTime, setOneTime] = useState<unknown>();
  const [referenceOptions, setReferenceOptions] = useState<ReferenceOptions>({});
  const explicitSourceKey = JSON.stringify(props.referenceOptionSources ?? {});
  const referenceOptionSources = useMemo(() => ({
    ...inferredReferenceOptionSources(props.listPath),
    ...(props.referenceOptionSources ?? {}),
  }), [props.listPath, explicitSourceKey]);
  const referenceSourceKey = JSON.stringify(referenceOptionSources);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try { setPayload(await apiRequest(props.listPath)); }
    catch (cause) { setError(cause); }
    finally { setLoading(false); }
  }, [props.listPath]);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    if (Object.keys(referenceOptionSources).length === 0) { setReferenceOptions({}); return; }
    let cancelled = false;
    void Promise.all(Object.entries(referenceOptionSources).map(async ([field, path]) => {
      const result = await apiRequest(path);
      const options = extractItems(result).filter((item) => typeof item.id === "string").map((item) => ({ value: String(item.id), label: optionLabel(item) }));
      return [field, options] as const;
    })).then((entries) => { if (!cancelled) setReferenceOptions(Object.fromEntries(entries)); }).catch((cause) => { if (!cancelled) setError(cause); });
    return () => { cancelled = true; };
    // The serialized key intentionally controls request identity for inline source objects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [referenceSourceKey]);

  const items = useMemo(() => extractItems(payload), [payload]);
  const columns = useMemo(() => {
    const preferred = ["id", "name", "displayName", "email", "status", "health", "type", "createdAt"];
    const keys = new Set(items.flatMap((item) => Object.keys(item).filter((key) => {
      const value = item[key];
      return value == null || ["string", "number", "boolean"].includes(typeof value);
    })));
    return [...preferred.filter((key) => keys.has(key)), ...[...keys].filter((key) => !preferred.includes(key))].slice(0, 8);
  }, [items]);

  async function mutate(path: string, method: "POST" | "PATCH" | "DELETE", body?: Record<string, unknown>, oneTimeResponse = false) {
    setError(undefined);
    try {
      const result = await apiRequest(path, { method, body });
      if (oneTimeResponse) setOneTime(result);
      await reload();
    } catch (cause) {
      setError(cause);
      throw cause;
    }
  }

  return (
    <section>
      <header>
        <h2>{props.title}</h2>
        {props.help ? <p>{props.help}</p> : null}
        <button type="button" onClick={() => void reload()}>Refresh</button>
      </header>
      {error ? <ErrorState error={error} /> : null}
      {oneTime != null ? <OneTimeCredential value={oneTime} /> : null}
      {props.createPath && allowed(props.permissions, props.createPermission) ? (
        <details>
          <summary>Create</summary>
          <JsonPayloadForm initialValue={props.createInitialValue} referenceOptions={referenceOptions} submitLabel="Create" onSubmit={async (body) => { await mutate(props.createPath!, "POST", body, props.oneTimeCreateResponse); }} />
        </details>
      ) : null}
      {loading ? <p>Loading…</p> : items.length === 0 ? <p>No resources.</p> : (
        <div className="rp-table-scroll"><table>
          <thead><tr>{columns.map((column) => <th key={column}>{fieldLabel(column)}</th>)}<th>Actions</th></tr></thead>
          <tbody>
            {items.map((item, index) => {
              const id = String(item.id ?? index);
              const deletePath = props.deletePath ?? props.itemPath;
              return (
                <tr key={id}>
                  {columns.map((column) => <td key={column}><StructuredValue fieldKey={column} value={item[column]} /></td>)}
                  <td>
                    {props.detailHref ? <a href={props.detailHref(item)}>Open</a> : null}
                    <details><summary>Details</summary><ReadableDataView value={item} hiddenKeys={columns} /></details>
                    {props.itemPath && allowed(props.permissions, props.updatePermission) ? (
                      <details><summary>Patch</summary><JsonPayloadForm initialValue={patchTemplate(props, item)} referenceOptions={referenceOptions} submitLabel="Save" onSubmit={async (body) => { await mutate(props.itemPath!(item), "PATCH", body); }} /></details>
                    ) : null}
                    {deletePath && allowed(props.permissions, props.deletePermission) ? (
                      <ConfirmButton confirm={`Delete ${props.title} resource ${id}?`} onConfirm={() => mutate(deletePath(item), "DELETE")}>Delete</ConfirmButton>
                    ) : null}
                    {(props.actions ?? []).filter((action) => allowed(props.permissions, action.permission)).map((action) => action.body ? (
                      <details key={action.label}><summary>{action.label}</summary><JsonPayloadForm initialValue={action.initialValue} referenceOptions={referenceOptions} submitLabel={action.label} onSubmit={async (body) => { await mutate(action.path(item), action.method, body, action.oneTimeResponse); }} /></details>
                    ) : action.destructive ? (
                      <ConfirmButton key={action.label} confirm={`${action.label} ${id}?`} onConfirm={() => mutate(action.path(item), action.method, undefined, action.oneTimeResponse)}>{action.label}</ConfirmButton>
                    ) : (
                      <button key={action.label} type="button" onClick={() => void mutate(action.path(item), action.method, undefined, action.oneTimeResponse)}>{action.label}</button>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      )}
    </section>
  );
}

export function ReadOnlyPanel({ title, path }: { title: string; path: string }) {
  const [data, setData] = useState<unknown>();
  const [error, setError] = useState<unknown>();
  useEffect(() => { setData(undefined); setError(undefined); apiRequest(path).then(setData).catch(setError); }, [path]);
  return <section><header><h2>{title}</h2></header>{error ? <ErrorState error={error} /> : data === undefined ? <p>Loading…</p> : typeof data === "string" ? <pre>{data}</pre> : <ReadableDataView value={data} />}</section>;
}
