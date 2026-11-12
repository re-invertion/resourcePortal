-- #430 expand/backfill. Designed to be rerunnable as part of a restored DB.
-- Do not activate exact-client enforcement before live ZITADEL certification.
-- Preserve legacy TenantAppConsumer data for rollback; never merge identities by e-mail.
ALTER TABLE "TenantAppClientGrant" DROP CONSTRAINT "TenantAppClientGrant_membershipId_tenantId_fkey";
ALTER TABLE "TenantAppClientGrant" ADD CONSTRAINT "TenantAppClientGrant_membershipId_tenantId_fkey"
  FOREIGN KEY ("membershipId", "tenantId") REFERENCES "TenantMembership"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TenantInvitation" ADD COLUMN "nativeApplicationKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE TABLE "TenantNativeAppGrant" (
  "id" UUID NOT NULL,
  "membershipId" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "clientKey" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdBy" UUID NOT NULL,
  "updatedBy" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TenantNativeAppGrant_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TenantNativeAppGrant_clientKey_check" CHECK ("clientKey" IN ('web','cli')),
  CONSTRAINT "TenantNativeAppGrant_membershipId_tenantId_fkey" FOREIGN KEY ("membershipId", "tenantId") REFERENCES "TenantMembership"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TenantNativeAppGrant_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "TenantNativeAppGrant_membershipId_clientKey_key" ON "TenantNativeAppGrant"("membershipId", "clientKey");
CREATE INDEX "TenantNativeAppGrant_tenantId_clientKey_enabled_idx" ON "TenantNativeAppGrant"("tenantId", "clientKey", "enabled");

-- Durable, non-PII inventory of rows created by the migration. Use for
-- approval of legacy broad-project access and scoped reversal of backfill.
CREATE TABLE "Iam430BackfillAudit" (
  "id" BIGSERIAL PRIMARY KEY,
  "kind" TEXT NOT NULL,
  "membershipId" UUID NOT NULL,
  "resourceId" TEXT NOT NULL,
  "recordId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Iam430BackfillAudit_kind_membership_resource_key" UNIQUE ("kind","membershipId","resourceId")
);

-- Existing role and consumer records must retain their existing credentials.
INSERT INTO "Role" ("id", "name", "permissions")
VALUES ('sso-login', 'SSO Login (no ResourcePortal permissions)', ARRAY[]::TEXT[])
ON CONFLICT ("id") DO NOTHING;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "Role" WHERE "id"='sso-login' AND cardinality("permissions") <> 0)
    OR EXISTS (SELECT 1 FROM "RolePermission" WHERE "roleId"='sso-login') THEN
    RAISE EXCEPTION 'sso-login must never carry ResourcePortal permissions';
  END IF;
END $$;

WITH inserted AS (
 INSERT INTO "MembershipRole" ("membershipId","roleId")
 SELECT m."id", 'sso-login' FROM "TenantMembership" m
 WHERE EXISTS (SELECT 1 FROM "MembershipRole" r WHERE r."membershipId"=m."id" AND r."roleId"<>'sso-login')
   OR EXISTS (SELECT 1 FROM "TenantAppConsumer" c WHERE c."membershipId"=m."id")
   OR EXISTS (SELECT 1 FROM "TenantGroupMember" gm JOIN "TenantGroupRole" gr ON gr."tenantGroupId"=gm."tenantGroupId"
     WHERE gm."membershipId"=m."id" AND gr."roleId"<>'sso-login')
 ON CONFLICT DO NOTHING RETURNING "membershipId","roleId"
)
INSERT INTO "Iam430BackfillAudit" ("kind","membershipId","resourceId","recordId")
SELECT 'sso-role',"membershipId","roleId","roleId" FROM inserted;

-- Legacy project-member policy previously permitted every application in the
-- same project when membership had an RP role. Snapshot those exact app IDs.
WITH inserted AS (
 INSERT INTO "TenantAppClientGrant"
   ("id","membershipId","tenantId","oauthApplicationId","enabled","createdBy","updatedBy","createdAt","updatedAt")
 SELECT gen_random_uuid(), m."id",m."tenantId",a."id",true,m."createdBy",m."createdBy",now(),now()
 FROM "TenantMembership" m
 JOIN "OAuthApplication" a ON a."tenantId"=m."tenantId"
 WHERE NOT EXISTS (SELECT 1 FROM "TenantAppConsumer" c WHERE c."membershipId"=m."id")
   AND (EXISTS (SELECT 1 FROM "MembershipRole" r WHERE r."membershipId"=m."id" AND r."roleId"<>'sso-login')
     OR EXISTS (SELECT 1 FROM "TenantGroupMember" gm JOIN "TenantGroupRole" gr ON gr."tenantGroupId"=gm."tenantGroupId"
       WHERE gm."membershipId"=m."id" AND gr."roleId"<>'sso-login'))
 ON CONFLICT DO NOTHING RETURNING "id","membershipId","oauthApplicationId"
)
INSERT INTO "Iam430BackfillAudit" ("kind","membershipId","resourceId","recordId")
SELECT 'tenant-app',"membershipId","oauthApplicationId"::TEXT,"id"::TEXT FROM inserted;

-- Only users not marked app-only in ANY tenant previously passed the RP native
-- policy. Snapshot Web and CLI separately to preserve (not broaden) access.
WITH inserted AS (
 INSERT INTO "TenantNativeAppGrant"
   ("id","membershipId","tenantId","clientKey","enabled","createdBy","updatedBy","createdAt","updatedAt")
 SELECT gen_random_uuid(),m."id",m."tenantId", client."key",true,m."createdBy",m."createdBy",now(),now()
 FROM "TenantMembership" m CROSS JOIN (VALUES ('web'),('cli')) AS client("key")
 WHERE NOT EXISTS (SELECT 1 FROM "TenantAppConsumer" other JOIN "TenantMembership" om ON om."id"=other."membershipId"
                   WHERE om."userId"=m."userId")
   AND (EXISTS (SELECT 1 FROM "MembershipRole" r WHERE r."membershipId"=m."id" AND r."roleId"<>'sso-login')
     OR EXISTS (SELECT 1 FROM "TenantGroupMember" gm JOIN "TenantGroupRole" gr ON gr."tenantGroupId"=gm."tenantGroupId"
       WHERE gm."membershipId"=m."id" AND gr."roleId"<>'sso-login'))
 ON CONFLICT DO NOTHING RETURNING "id","membershipId","clientKey"
)
INSERT INTO "Iam430BackfillAudit" ("kind","membershipId","resourceId","recordId")
SELECT 'native-app',"membershipId","clientKey","id"::TEXT FROM inserted;
