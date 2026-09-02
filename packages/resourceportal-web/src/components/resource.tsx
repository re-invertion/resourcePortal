import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, apiRequest } from "../api/client";
import { ConfirmButton, JsonPayloadForm, OneTimeCredential } from "./forms";

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
};

function allowed(permissions: string[] | undefined, permission: string | undefined) {
  if (!permission || !permissions) return true;
  return permissions.includes("*") || permissions.includes(permission);
}

function extractItems(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item));
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    for (const key of ["items", "records", "data", "results"]) {
      if (Array.isArray(record[key])) return extractItems(record[key]);
    }
    return [record];
  }
  return [];
}

function display(value: unknown) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
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

  const reload = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try { setPayload(await apiRequest(props.listPath)); }
    catch (cause) { setError(cause); }
    finally { setLoading(false); }
  }, [props.listPath]);

  useEffect(() => { void reload(); }, [reload]);
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
          <JsonPayloadForm initialValue={props.createInitialValue} submitLabel="Create" onSubmit={async (body) => { await mutate(props.createPath!, "POST", body, props.oneTimeCreateResponse); }} />
        </details>
      ) : null}
      {loading ? <p>Loading…</p> : items.length === 0 ? <p>No resources.</p> : (
        <table>
          <thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}<th>Actions</th></tr></thead>
          <tbody>
            {items.map((item, index) => {
              const id = String(item.id ?? index);
              const deletePath = props.deletePath ?? props.itemPath;
              return (
                <tr key={id}>
                  {columns.map((column) => <td key={column}>{display(item[column])}</td>)}
                  <td>
                    {props.detailHref ? <a href={props.detailHref(item)}>Open</a> : null}
                    <details><summary>Details</summary><pre>{JSON.stringify(item, null, 2)}</pre></details>
                    {props.itemPath && allowed(props.permissions, props.updatePermission) ? (
                      <details><summary>Patch</summary><JsonPayloadForm initialValue={patchTemplate(props, item)} submitLabel="Save" onSubmit={async (body) => { await mutate(props.itemPath!(item), "PATCH", body); }} /></details>
                    ) : null}
                    {deletePath && allowed(props.permissions, props.deletePermission) ? (
                      <ConfirmButton confirm={`Delete ${props.title} resource ${id}?`} onConfirm={() => mutate(deletePath(item), "DELETE")}>Delete</ConfirmButton>
                    ) : null}
                    {(props.actions ?? []).filter((action) => allowed(props.permissions, action.permission)).map((action) => action.body ? (
                      <details key={action.label}><summary>{action.label}</summary><JsonPayloadForm initialValue={action.initialValue} submitLabel={action.label} onSubmit={async (body) => { await mutate(action.path(item), action.method, body, action.oneTimeResponse); }} /></details>
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
        </table>
      )}
    </section>
  );
}

export function ReadOnlyPanel({ title, path }: { title: string; path: string }) {
  const [data, setData] = useState<unknown>();
  const [error, setError] = useState<unknown>();
  useEffect(() => { setData(undefined); setError(undefined); apiRequest(path).then(setData).catch(setError); }, [path]);
  return <section><h2>{title}</h2>{error ? <ErrorState error={error} /> : data === undefined ? <p>Loading…</p> : <pre>{typeof data === "string" ? data : JSON.stringify(data, null, 2)}</pre>}</section>;
}
