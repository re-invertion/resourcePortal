-- Preserve the human-only boundary: automatic expedited reconciliation may
-- reactivate a previously approved provider, never activate one for the first time.
ALTER TABLE "TenantOidcProvider" ADD COLUMN "lastActivatedAt" TIMESTAMP(3);

-- Existing active providers have already passed their activation boundary.
UPDATE "TenantOidcProvider"
SET "lastActivatedAt" = "updatedAt"
WHERE "enabled" = true AND "status" = 'Active';
