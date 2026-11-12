-- #430 read-only rollback preflight. NO mutations; do not treat zero findings
-- as evidence of a tested, restorable backup or a successful downgrade.
-- Execute against a dedicated maintenance/read-only transaction with backups.
BEGIN TRANSACTION READ ONLY;
WITH untracked AS (
  SELECT g."id"::text AS id
  FROM "TenantAppClientGrant" g
  LEFT JOIN "TenantAppConsumer" legacy ON legacy."membershipId"=g."membershipId"
  LEFT JOIN "Iam430BackfillAudit" a ON a."kind"='tenant-app' AND a."recordId"=g."id"::text
  WHERE legacy."membershipId" IS NULL AND a."id" IS NULL
), native_untracked AS (
  SELECT g."id"::text AS id
  FROM "TenantNativeAppGrant" g
  LEFT JOIN "Iam430BackfillAudit" a ON a."kind"='native-app' AND a."recordId"=g."id"::text
  WHERE a."id" IS NULL
), sso_untracked AS (
  SELECT m."membershipId"::text AS id
  FROM "MembershipRole" m
  LEFT JOIN "Iam430BackfillAudit" a ON a."kind"='sso-role'
      AND a."membershipId"=m."membershipId" AND a."resourceId"='sso-login'
  WHERE m."roleId"='sso-login' AND a."id" IS NULL
), invited AS (
  SELECT i."id"::text AS id FROM "TenantInvitation" i
  WHERE cardinality(i."nativeApplicationKeys") > 0
)
SELECT 'untracked_app_grants_without_legacy_owner' AS blocker, COUNT(*)::int AS rows FROM untracked
UNION ALL
SELECT 'untracked_native_client_grants', COUNT(*)::int FROM native_untracked
UNION ALL
SELECT 'untracked_sso_role_assignments', COUNT(*)::int FROM sso_untracked
UNION ALL
SELECT 'pending_native_client_invitations', COUNT(*)::int FROM invited;
ROLLBACK;
