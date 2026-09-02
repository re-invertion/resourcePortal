import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../api/client";
import type { ReferenceOptions } from "./form-contracts";

type Payload = Record<string, unknown>;

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

function optionLabel(item: Record<string, unknown>) {
  for (const key of ["displayName", "name", "email", "rootDomain", "host", "id"]) {
    if (typeof item[key] === "string" && item[key]) return String(item[key]);
  }
  return String(item.id ?? "Unknown resource");
}

function sourcesFor(values: Payload | undefined) {
  if (!values || typeof window === "undefined") return {};
  const sources: Record<string, string> = {};
  const path = window.location.pathname;
  const tenantMatch = path.match(/^\/tenants\/([^/]+)/);
  const tenantId = tenantMatch?.[1] ? decodeURIComponent(tenantMatch[1]) : undefined;
  const appGroupMatch = path.match(/^\/tenants\/([^/]+)\/app-groups\/([^/]+)/);
  const appGroupId = appGroupMatch?.[2] ? decodeURIComponent(appGroupMatch[2]) : undefined;
  const tenantRoot = tenantId ? `/api/tenants/${encodeURIComponent(tenantId)}` : undefined;
  const appGroupRoot = tenantRoot && appGroupId ? `${tenantRoot}/app-groups/${encodeURIComponent(appGroupId)}` : undefined;

  if ("tenantId" in values && path.startsWith("/platform/")) sources.tenantId = "/api/tenants";
  if (tenantRoot && "registryId" in values) sources.registryId = `${tenantRoot}/registries`;
  if (tenantRoot && "roleIds" in values) sources.roleIds = `${tenantRoot}/roles`;
  if (tenantRoot && "customRootDomainId" in values) sources.customRootDomainId = `${tenantRoot}/domains/custom-root-domains`;
  if (tenantRoot && "volumeId" in values) sources.volumeId = `${tenantRoot}/volumes`;
  if (appGroupRoot && "variableId" in values) sources.variableId = `${appGroupRoot}/variables`;
  if (appGroupRoot && "configId" in values) sources.configId = `${appGroupRoot}/configs`;
  if (appGroupRoot && "secretId" in values) sources.secretId = `${appGroupRoot}/secrets`;
  return sources;
}

export function useAutomaticReferenceOptions(values: Payload | undefined, provided: ReferenceOptions | undefined) {
  const [loaded, setLoaded] = useState<ReferenceOptions>({});
  const sources = useMemo(() => provided === undefined ? sourcesFor(values) : {}, [provided, values]);
  const sourceKey = JSON.stringify(sources);

  useEffect(() => {
    if (provided !== undefined || Object.keys(sources).length === 0) { setLoaded({}); return; }
    let cancelled = false;
    void Promise.all(Object.entries(sources).map(async ([field, path]) => {
      const result = await apiRequest(path);
      const options = extractItems(result)
        .filter((item) => typeof item.id === "string")
        .map((item) => ({ value: String(item.id), label: optionLabel(item) }));
      return [field, options] as const;
    })).then((entries) => { if (!cancelled) setLoaded(Object.fromEntries(entries)); }).catch(() => {
      if (!cancelled) setLoaded({});
    });
    return () => { cancelled = true; };
    // sourceKey is a stable representation of the inferred API paths.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provided, sourceKey]);

  return provided ?? loaded;
}
