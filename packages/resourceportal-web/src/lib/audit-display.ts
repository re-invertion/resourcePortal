export type AuditDisplayRow = Record<string, unknown>;

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numericValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function isGroupedBillingUsage(row: AuditDisplayRow) {
  return row.grouped === true && stringValue(row.action) === "billing.usage_charge";
}

export function auditActionLabel(row: AuditDisplayRow) {
  return isGroupedBillingUsage(row) ? "Billing usage" : stringValue(row.action, "Change");
}

export function auditGroupedCount(row: AuditDisplayRow) {
  return isGroupedBillingUsage(row) ? numericValue(row.groupedCount) : 0;
}

export function auditResourceLabel(row: AuditDisplayRow) {
  if (isGroupedBillingUsage(row)) {
    const count = auditGroupedCount(row);
    return `${count} usage event${count === 1 ? "" : "s"} grouped`;
  }
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
