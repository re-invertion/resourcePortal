ALTER TABLE "CustomRootDomain"
  DROP CONSTRAINT IF EXISTS "CustomRootDomain_rootDomain_key";

CREATE UNIQUE INDEX IF NOT EXISTS "CustomRootDomain_tenantId_rootDomain_key"
  ON "CustomRootDomain"("tenantId", "rootDomain");

CREATE INDEX IF NOT EXISTS "CustomRootDomain_tenantId_idx"
  ON "CustomRootDomain"("tenantId");

ALTER TABLE "CustomRootDomain"
  ADD CONSTRAINT "CustomRootDomain_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
