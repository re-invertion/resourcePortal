const auditFilterKeys = [
  "action",
  "actor",
  "resourceType",
  "resourceId",
  "result",
  "requestId",
  "correlationId",
  "from",
  "to",
] as const;

function pick(value: Record<string, unknown>, keys: readonly string[]) {
  const selected: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in value) selected[key] = value[key];
  }
  return selected;
}

function toQuery(value: Record<string, unknown>) {
  const params = new URLSearchParams();
  for (const [key, raw] of Object.entries(value)) {
    if (raw == null || raw === "") continue;
    for (const item of Array.isArray(raw) ? raw : [raw]) params.append(key, String(item));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function buildAuditQueries(value: Record<string, unknown>) {
  return {
    list: toQuery(pick(value, [...auditFilterKeys, "cursor", "limit"])),
    export: toQuery(pick(value, [...auditFilterKeys, "format"])),
  };
}

export function formatAuditExport(value: unknown) {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}
