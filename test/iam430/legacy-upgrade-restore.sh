#!/usr/bin/env bash
set -euo pipefail
# Disposable PostgreSQL only. No production credentials or network callbacks.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[[ "${GITHUB_ACTIONS:-}" == true && "${DATABASE_URL:-}" == *"@localhost:5432/iam430"* ]] || {
  echo 'Refusing migration test outside isolated CI database' >&2; exit 1;
}
# Prisma accepts ?schema=public, but libpq utilities (psql/pg_dump) do not.
pgurl="${DATABASE_URL%%\?*}"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
schema="$root/packages/resourceportal-api/prisma/schema.prisma"
migrations="$root/packages/resourceportal-api/prisma/migrations"
mkdir -p "$tmp/baseline/migrations"
cp "$schema" "$tmp/baseline/schema.prisma"
cp "$migrations/migration_lock.toml" "$tmp/baseline/migrations/"
for dir in "$migrations"/*; do
  [[ -d "$dir" ]] || continue
  [[ "${dir##*/}" == 20261112094000_unified_identity_expand ]] && continue
  cp -a -- "$dir" "$tmp/baseline/migrations/"
done

cd "$root/packages/resourceportal-api"
echo "Apply all pre-#430 migrations to disposable legacy schema"
npx prisma migrate deploy --schema "$tmp/baseline/schema.prisma"
psql "$pgurl" -v ON_ERROR_STOP=1 -f "$root/test/iam430/legacy-fixture.sql" >/dev/null

dump="$tmp/legacy.dump"
# Pin pg_dump to the PostgreSQL 16 server version: newer pg_restore
# generates SET transaction_timeout, which PostgreSQL 16 cannot execute.
# This CI-only container performs no migrations, writes or network callbacks.
docker run --rm --network host --read-only --cap-drop ALL \
  --security-opt no-new-privileges --pull never \
  --user "$(id -u):$(id -g)" -e PGPASSWORD \
  postgres:16 pg_dump --format=custom --no-owner --no-acl "$pgurl" >"$dump"
[[ -s "$dump" ]] || { echo 'Baseline dump is empty' >&2; exit 1; }
echo "Upgrade legacy database with actual new Prisma migration"
npx prisma migrate deploy --schema "$schema"
assert_count() {
  local url="$1" label="$2" expected="$3" query="$4" actual
  actual="$(psql "$url" -X -v ON_ERROR_STOP=1 -Atc "$query")"
  [[ "$actual" == "$expected" ]] || {
    printf 'FAIL: %s, expected=%s actual=%s\n' "$label" "$expected" "$actual" >&2
    exit 1
  }
  printf 'PASS: %s = %s\n' "$label" "$actual"
}
assert_count "$pgurl" 'Original users kept' 3 'SELECT count(*) FROM "User"'
assert_count "$pgurl" 'Identity issuer+subject unmerged' 3 'SELECT count(DISTINCT ("issuer","externalSubject")) FROM "UserIdentity"'
assert_count "$pgurl" 'Tenant memberships preserved' 3 'SELECT count(*) FROM "TenantMembership"'
assert_count "$pgurl" 'Legacy App Consumer marker preserved' 1 'SELECT count(*) FROM "TenantAppConsumer"'
assert_count "$pgurl" 'Original App Consumer grant kept' 1 \
  'SELECT count(*) FROM "TenantAppClientGrant" WHERE "id"=$$55555555-5555-4555-8555-555555555555$$'
assert_count "$pgurl" 'All existing tenant-owner roles preserved' 1 \
  'SELECT count(*) FROM "MembershipRole" WHERE "roleId"=$$tenant-owner$$'
assert_count "$pgurl" 'SSO granted only to old authorized identities' 2 \
  'SELECT count(*) FROM "MembershipRole" WHERE "roleId"=$$sso-login$$'
assert_count "$pgurl" 'sso-login has no RBAC bindings' 0 \
  'SELECT count(*) FROM "RolePermission" WHERE "roleId"=$$sso-login$$'
assert_count "$pgurl" 'Only genuinely eligible matching OAuth project backfilled' 1 \
  'SELECT count(*) FROM "Iam430BackfillAudit" WHERE "kind"=$$tenant-app$$'
assert_count "$pgurl" 'Native Web and CLI preserved for legacy RP owner only' 2 \
  'SELECT count(*) FROM "TenantNativeAppGrant"'
assert_count "$pgurl" 'Role-free identity did not acquire grants' 0 \
  'SELECT count(*) FROM "TenantNativeAppGrant" WHERE "membershipId"=$$77777777-7777-4777-8777-777777777777$$'
assert_count "$pgurl" 'No cross-tenant or wrong-project app grants' 0 \
  'SELECT count(*) FROM "TenantAppClientGrant" g JOIN "OAuthApplication" a ON a."id"=g."oauthApplicationId" WHERE g."tenantId" <> a."tenantId" OR a."zitadelProjectId"=$$wrong-project$$'
assert_count "$pgurl" 'Original same email does not cause auto identity merge' 2 \
  'SELECT count(*) FROM "UserIdentity" WHERE "email"=$$common-identity@example.test$$'
echo "Verify rollback preflight is read-only and all new grants are accounted for"
preflight="$(psql "$pgurl" -X -v ON_ERROR_STOP=1 -At -f "$root/docs/iam430-rollback-preflight.sql")"
printf '%s\n' "$preflight" >"$tmp/preflight.out"
for blocker in untracked_app_grants_without_legacy_owner untracked_native_client_grants \
  untracked_sso_role_assignments pending_native_client_invitations \
  revoked_or_missing_backfilled_native_grants revoked_or_missing_backfilled_app_grants \
  removed_backfilled_sso_roles; do
  grep -Fx -- "$blocker|0" "$tmp/preflight.out" >/dev/null || {
    echo "FAIL: rollback preflight found untracked privileges or malformed output: $blocker" >&2
    exit 1
  }
done
assert_count "$pgurl" 'Preflight transaction performed no writes' 1 \
  'SELECT count(*) FROM "Iam430BackfillAudit" WHERE "kind"=$$tenant-app$$'
echo "Verify a revoked backfilled Web grant blocks schema-down rollback"
psql "$pgurl" -X -v ON_ERROR_STOP=1 -c \
  'UPDATE "TenantNativeAppGrant" SET "enabled"=false WHERE "id" IN (
     SELECT "recordId"::uuid FROM "Iam430BackfillAudit" WHERE "kind"=$native-app$ AND "resourceId"=$web$
   )' >/dev/null
assert_count "$pgurl" 'Web grant explicitly revoked' 1 \
  'SELECT count(*) FROM "TenantNativeAppGrant" WHERE "clientKey"=$web$ AND "enabled"=false'
preflight="$(psql "$pgurl" -X -v ON_ERROR_STOP=1 -At -f "$root/docs/iam430-rollback-preflight.sql")"
grep -Fx 'revoked_or_missing_backfilled_native_grants|1' <<<"$preflight" >/dev/null || {
  echo 'FAIL: preflight would reauthorize previously revoked native Web grant' >&2; exit 1;
}
psql "$pgurl" -X -v ON_ERROR_STOP=1 -c \
  'UPDATE "TenantNativeAppGrant" SET "enabled"=true WHERE "id" IN (
     SELECT "recordId"::uuid FROM "Iam430BackfillAudit" WHERE "kind"=$native-app$ AND "resourceId"=$web$
   )' >/dev/null

echo "Verify a revoked backfilled OAuth app grant blocks schema-down rollback"
psql "$pgurl" -X -v ON_ERROR_STOP=1 -c \
  'UPDATE "TenantAppClientGrant" SET "enabled"=false WHERE "id" IN (
     SELECT "recordId"::uuid FROM "Iam430BackfillAudit" WHERE "kind"=$tenant-app$
   )' >/dev/null
assert_count "$pgurl" 'Legacy RP app backfill intentionally revoked' 1 \
  'SELECT count(*) FROM "TenantAppClientGrant" WHERE "enabled"=false'
preflight="$(psql "$pgurl" -X -v ON_ERROR_STOP=1 -At -f "$root/docs/iam430-rollback-preflight.sql")"
grep -Fx 'revoked_or_missing_backfilled_app_grants|1' <<<"$preflight" >/dev/null || {
  echo 'FAIL: preflight would reauthorize a revoked migrated OAuth client' >&2; exit 1;
}
psql "$pgurl" -X -v ON_ERROR_STOP=1 -c \
  'UPDATE "TenantAppClientGrant" SET "enabled"=true WHERE "id" IN (
     SELECT "recordId"::uuid FROM "Iam430BackfillAudit" WHERE "kind"=$tenant-app$
   )' >/dev/null

echo "Verify removing a backfilled SSO role blocks schema-down rollback"
psql "$pgurl" -X -v ON_ERROR_STOP=1 -c \
  'DELETE FROM "MembershipRole" WHERE "roleId"=$sso-login$ AND "membershipId" IN (
     SELECT "membershipId" FROM "Iam430BackfillAudit" WHERE "kind"=$sso-role$
   )' >/dev/null
preflight="$(psql "$pgurl" -X -v ON_ERROR_STOP=1 -At -f "$root/docs/iam430-rollback-preflight.sql")"
grep -Fx 'removed_backfilled_sso_roles|1' <<<"$preflight" >/dev/null || {
  echo 'FAIL: preflight would restore SSO login after its role was revoked' >&2; exit 1;
}
psql "$pgurl" -X -v ON_ERROR_STOP=1 -c \
  'INSERT INTO "MembershipRole" ("membershipId","roleId")
    SELECT "membershipId", $sso-login$ FROM "Iam430BackfillAudit" WHERE "kind"=$sso-role$' >/dev/null
preflight="$(psql "$pgurl" -X -v ON_ERROR_STOP=1 -At -f "$root/docs/iam430-rollback-preflight.sql")"
for blocker in revoked_or_missing_backfilled_native_grants \
  revoked_or_missing_backfilled_app_grants removed_backfilled_sso_roles; do
  grep -Fx -- "$blocker|0" <<<"$preflight" >/dev/null || {
    echo "FAIL: restored migration grants still block preflight: $blocker" >&2; exit 1;
  }
done
echo "Restore legacy source snapshot to a second clean PostgreSQL database"
psql "postgresql://iam430:iam430_ci_only@localhost:5432/postgres" -v ON_ERROR_STOP=1 \
  -c 'CREATE DATABASE iam430_restore' >/dev/null
restore_url='postgresql://iam430:iam430_ci_only@localhost:5432/iam430_restore'
docker run --rm --network host --read-only --cap-drop ALL \
  --security-opt no-new-privileges --pull never \
  --user "$(id -u):$(id -g)" -e PGPASSWORD \
  --interactive postgres:16 pg_restore --clean --if-exists --no-owner --no-acl \
  --exit-on-error --dbname="$restore_url" <"$dump"
assert_count "$restore_url" 'Restored original users' 3 'SELECT count(*) FROM "User"'
assert_count "$restore_url" 'Restored legacy app grant' 1 'SELECT count(*) FROM "TenantAppClientGrant"'
assert_count "$restore_url" 'Restored legacy RP owner role' 1 \
  'SELECT count(*) FROM "MembershipRole" WHERE "roleId"=$$tenant-owner$$'
assert_count "$restore_url" 'No backfilled SSO role on restored source' 0 \
  'SELECT count(*) FROM "Role" WHERE "id"=$$sso-login$$'
assert_count "$restore_url" 'New native table absent in restored source' 0 \
  'SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname=$$public$$ AND tablename=$$TenantNativeAppGrant$$'
echo 'PASS: isolated legacy migration, entitlement inventory and PostgreSQL snapshot restore'
