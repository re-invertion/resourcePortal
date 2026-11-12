#!/usr/bin/env bash
set -euo pipefail
# Disposable PostgreSQL only. No production credentials or network callbacks.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[[ "${GITHUB_ACTIONS:-}" == true && "${DATABASE_URL:-}" == *"@localhost:5432/iam430"* ]] || {
  echo 'Refusing migration test outside isolated CI database' >&2; exit 1;
}
# Prisma accepts ?schema=public, but libpq utilities (psql/pg_dump) do not.
pgurl="${DATABASE_URL%%\\?*}"
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
pg_dump --format=custom --no-owner --no-acl --file="$dump" "$pgurl"
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
  'SELECT count(*) FROM "TenantAppClientGrant" WHERE "id"=$55555555-5555-4555-8555-555555555555$'
assert_count "$pgurl" 'All existing tenant-owner roles preserved' 1 \
  'SELECT count(*) FROM "MembershipRole" WHERE "roleId"=$tenant-owner$'
assert_count "$pgurl" 'SSO granted only to old authorized identities' 2 \
  'SELECT count(*) FROM "MembershipRole" WHERE "roleId"=$sso-login$'
assert_count "$pgurl" 'sso-login has no RBAC bindings' 0 \
  'SELECT count(*) FROM "RolePermission" WHERE "roleId"=$sso-login$'
assert_count "$pgurl" 'Only genuinely eligible matching OAuth project backfilled' 1 \
  'SELECT count(*) FROM "Iam430BackfillAudit" WHERE "kind"=$tenant-app$'
assert_count "$pgurl" 'Native Web and CLI preserved for legacy RP owner only' 2 \
  'SELECT count(*) FROM "TenantNativeAppGrant"'
assert_count "$pgurl" 'Role-free identity did not acquire grants' 0 \
  'SELECT count(*) FROM "TenantNativeAppGrant" WHERE "membershipId"=$77777777-7777-4777-8777-777777777777$'
assert_count "$pgurl" 'No cross-tenant or wrong-project app grants' 0 \
  'SELECT count(*) FROM "TenantAppClientGrant" g JOIN "OAuthApplication" a ON a."id"=g."oauthApplicationId" WHERE g."tenantId" <> a."tenantId" OR a."zitadelProjectId"=$wrong-project$'
assert_count "$pgurl" 'Original same email does not cause auto identity merge' 2 \
  'SELECT count(*) FROM "UserIdentity" WHERE "email"=$common-identity@example.test$'
echo "Restore legacy source snapshot to a second clean PostgreSQL database"
psql "postgresql://iam430:iam430_ci_only@localhost:5432/postgres" -v ON_ERROR_STOP=1 \
  -c 'CREATE DATABASE iam430_restore' >/dev/null
restore_url='postgresql://iam430:iam430_ci_only@localhost:5432/iam430_restore'
pg_restore --no-owner --no-acl --exit-on-error --dbname="$restore_url" "$dump"
assert_count "$restore_url" 'Restored original users' 3 'SELECT count(*) FROM "User"'
assert_count "$restore_url" 'Restored legacy app grant' 1 'SELECT count(*) FROM "TenantAppClientGrant"'
assert_count "$restore_url" 'Restored legacy RP owner role' 1 \
  'SELECT count(*) FROM "MembershipRole" WHERE "roleId"=$tenant-owner$'
assert_count "$restore_url" 'No backfilled SSO role on restored source' 0 \
  'SELECT count(*) FROM "Role" WHERE "id"=$sso-login$'
assert_count "$restore_url" 'New native table absent in restored source' 0 \
  'SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname=$public$ AND tablename=$TenantNativeAppGrant$'
echo 'PASS: isolated legacy migration, entitlement inventory and PostgreSQL snapshot restore'
