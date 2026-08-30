-- Stage 1 identity closure: the same OAuthApplication and ServiceIdentity resources
-- can be owned either by a Tenant (tenantId set) or by the Resource Portal platform
-- (tenantId NULL). Existing tenant rows and foreign keys remain unchanged.
ALTER TABLE "OAuthApplication"
  ALTER COLUMN "tenantId" DROP NOT NULL;

ALTER TABLE "ServiceIdentity"
  ALTER COLUMN "tenantId" DROP NOT NULL;

-- PostgreSQL composite UNIQUE treats NULL values as distinct, so platform-owned
-- resources need a partial unique index to preserve unique names at platform scope.
CREATE UNIQUE INDEX "OAuthApplication_platform_name_key"
  ON "OAuthApplication" ("name")
  WHERE "tenantId" IS NULL;

CREATE UNIQUE INDEX "ServiceIdentity_platform_name_key"
  ON "ServiceIdentity" ("name")
  WHERE "tenantId" IS NULL;

CREATE INDEX "OAuthApplication_platform_type_idx"
  ON "OAuthApplication" ("type")
  WHERE "tenantId" IS NULL;

CREATE INDEX "ServiceIdentity_platform_status_idx"
  ON "ServiceIdentity" ("status")
  WHERE "tenantId" IS NULL;
