CREATE INDEX IF NOT EXISTS "AuditLogEntry_tenantId_timestamp_idx"
ON "AuditLogEntry"("tenantId", "timestamp");

CREATE INDEX IF NOT EXISTS "AuditLogEntry_tenantId_action_timestamp_idx"
ON "AuditLogEntry"("tenantId", "action", "timestamp");
