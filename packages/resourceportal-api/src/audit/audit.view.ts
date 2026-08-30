import { AuditLogEntry, Prisma } from "@prisma/client";

const REDACTED = "[REDACTED]";

export function mapAuditLogEntry(entry: AuditLogEntry) {
  return {
    ...entry,
    changes: sanitizeAuditValue(entry.changes),
  };
}

function sanitizeAuditValue(value: Prisma.JsonValue | null): Prisma.JsonValue | null {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeAuditValue(item));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      isSensitiveKey(key) ? REDACTED : sanitizeAuditValue(item),
    ]),
  );
}

function isSensitiveKey(key: string) {
  const normalized = key.replaceAll(/[^a-zA-Z0-9]/g, "").toLowerCase();

  return (
    normalized.includes("password") ||
    normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("credential") ||
    normalized.includes("privatekey") ||
    normalized.includes("ciphertext")
  );
}
