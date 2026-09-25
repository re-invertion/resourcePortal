export type AuditDisplayRow = Record<string, unknown>;

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numericValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function changes(row: AuditDisplayRow) {
  return row.changes && typeof row.changes === "object" && !Array.isArray(row.changes)
    ? row.changes as Record<string, unknown>
    : undefined;
}

export function isGroupedBillingUsage(row: AuditDisplayRow) {
  return row.grouped === true && stringValue(row.action) === "billing.usage_charge";
}

export function isMcpAudit(row: AuditDisplayRow) {
  return stringValue(row.action).startsWith("tenant.mcp.");
}

export function auditActionLabel(row: AuditDisplayRow) {
  if (isGroupedBillingUsage(row)) return "Billing usage";
  const action = stringValue(row.action);
  if (action === "tenant.mcp.tool.call") return "MCP tool call";
  if (action === "tenant.mcp.settings.update") return "MCP settings updated";
  return action || "Change";
}

export function auditActionDetail(row: AuditDisplayRow) {
  if (stringValue(row.action) !== "tenant.mcp.tool.call") return "";
  const detail = changes(row);
  if (!detail) return "";
  const toolName = stringValue(detail.toolName);
  const method = stringValue(detail.method);
  const path = stringValue(detail.path);
  const statusCode = numericValue(detail.statusCode);
  const request = [method, path].filter(Boolean).join(" ");
  return [toolName, request, statusCode > 0 ? `HTTP ${statusCode}` : ""].filter(Boolean).join(" · ");
}

export function auditGroupedCount(row: AuditDisplayRow) {
  return isGroupedBillingUsage(row) ? numericValue(row.groupedCount) : 0;
}

export function auditResourceLabel(row: AuditDisplayRow) {
  if (isGroupedBillingUsage(row)) {
    const count = auditGroupedCount(row);
    return `${count} usage event${count === 1 ? "" : "s"} grouped`;
  }
  if (stringValue(row.resourceType) === "TenantMcp") return "MCP";
  return stringValue(row.resourceType, "—");
}

export function auditTimestampValue(row: AuditDisplayRow) {
  return row.timestamp ?? row.createdAt ?? row.updatedAt;
}

export function auditTimeRange(row: AuditDisplayRow) {
  if (!isGroupedBillingUsage(row)) return null;
  return {
    from: row.groupedFrom,
    to: row.groupedTo ?? row.timestamp,
  };
}
