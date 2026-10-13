#!/usr/bin/env bash
# Required publication safety test: run the *real* rp_upgrade_apply entry point
# against the actual previously published RP image digests and current locally
# built API/Web/Postgres release-candidate images, then inject a health failure.
# This proves the previous images, source RP/ZITADEL database snapshots,
# source Prisma schema and persisted data are ACTUALLY restored after failure.
set -euo pipefail

source_version="${1:-}"
[[ "$source_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "Usage: $0 PREVIOUS_PUBLISHED_VERSION (without v)" >&2
  exit 1
}
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
for cmd in jq docker curl gh flock; do
  command -v "$cmd" >/dev/null || { echo "Required rollback tool missing: $cmd" >&2; exit 1; }
done
docker info >/dev/null
current_sha="$(git rev-parse HEAD)"
[[ "$current_sha" =~ ^[a-f0-9]{40}$ ]] || exit 1
root="$(mktemp -d /tmp/resourceportal-rollback-gate.XXXXXX)"
stack="rp-rollback-gate-${GITHUB_RUN_ID:-$$}"
stack="${stack//[^a-zA-Z0-9_-]/-}"
db_network="${stack}-db-net"
db_container="${stack}-db"
zitadel_db_container="${stack}-zitadel-db"
old_api_probe="${stack}-previous-api-probe"
db_created=false
swarm_started=false
cleanup() {
  docker rm -f "$old_api_probe" "$zitadel_db_container" >/dev/null 2>&1 || true
  if [[ "$db_created" == true ]]; then
    docker rm -f "$db_container" >/dev/null 2>&1 || true
    docker network rm "$db_network" >/dev/null 2>&1 || true
  fi
  docker stack rm "$stack" >/dev/null 2>&1 || true
  if [[ "$swarm_started" == true ]]; then docker swarm leave --force >/dev/null 2>&1 || true; fi
  rm -rf -- "$root"
}
trap cleanup EXIT

# Never synthesize the rollback source: require the immutable official manifest
# and its signed attestation from the immediately preceding published release.
base_url="https://github.com/re-invertion/resourcePortal/releases/download/v${source_version}"
curl --fail --silent --show-error --location --proto '=https' \
  "$base_url/resourceportal-release-manifest.json" -o "$root/previous-release.json"
curl --fail --silent --show-error --location --proto '=https' \
  "$base_url/resourceportal-release-manifest.bundle.json" -o "$root/source.bundle.json"
GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1 gh attestation verify "$root/previous-release.json" \
  --bundle "$root/source.bundle.json" --repo re-invertion/resourcePortal \
  --signer-workflow re-invertion/resourcePortal/.github/workflows/release.yml \
  --source-ref refs/heads/main >/dev/null
source "$repo_root/scripts/installer/releases.sh"
source "$repo_root/scripts/installer/upgrade.sh"
rp_validate_release_manifest "$root/previous-release.json"
[[ "$(jq -er .version "$root/previous-release.json")" == "$source_version" ]] || exit 1

for role in api web postgres; do
  source_image="$(jq -er --arg role "$role" '.images[$role]' "$root/previous-release.json")"
  [[ "$source_image" =~ @sha256:[a-f0-9]{64}$ ]] || exit 1
  docker pull "$source_image" >/dev/null
  docker image inspect "resourceportal-${role}-candidate" >/dev/null
done
source_api="$(jq -er .images.api "$root/previous-release.json")"
source_web="$(jq -er .images.web "$root/previous-release.json")"
source_postgres="$(jq -er .images.postgres "$root/previous-release.json")"

# Test a real source PostgreSQL snapshot and restore, not merely old/new
# images running "sleep" or an old Prisma client using expanded schema. The
# exact signed previous-release Postgres/API images and candidate Prisma
# migrations run against disposable test databases, never live data.
docker network create "$db_network" >/dev/null
db_created=true
docker run -d --name "$db_container" --network "$db_network" \
  --network-alias migration-db \
  -e POSTGRES_DB=resource_portal -e POSTGRES_USER=resource_portal \
  -e POSTGRES_PASSWORD=rollback-smoke-only \
  "$source_postgres" >/dev/null
# Separate ZITADEL PostgreSQL must be restored, not just the RP DB schema.
docker run -d --name "$zitadel_db_container" --network "$db_network" \
  -e POSTGRES_DB=zitadel -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=rollback-smoke-only \
  "$source_postgres" >/dev/null
compat_url="postgresql://resource_portal:rollback-smoke-only@migration-db:5432/resource_portal?schema=public"
db_ready=false
for ((attempt=0;attempt<60;attempt++)); do
  if docker exec "$db_container" pg_isready -U resource_portal -d resource_portal >/dev/null 2>&1; then
    db_ready=true
    break
  fi
  sleep 2
done
[[ "$db_ready" == true ]] || { echo "Real compatibility database never became ready" >&2; exit 1; }
zitadel_ready=false
for ((attempt=0;attempt<60;attempt++)); do
  if docker exec "$zitadel_db_container" pg_isready -U postgres -d zitadel >/dev/null 2>&1; then
    zitadel_ready=true; break
  fi
  sleep 2
done
[[ "$zitadel_ready" == true ]] || { echo "ZITADEL snapshot database never became ready" >&2; exit 1; }
docker exec "$zitadel_db_container" psql -U postgres -d zitadel -v ON_ERROR_STOP=1 \
  -c "CREATE TABLE rollback_identity_probe (id integer PRIMARY KEY, marker text NOT NULL); INSERT INTO rollback_identity_probe VALUES (1, 'original');" >/dev/null

# Execute the *published* historical migrations first, using the pinned old
# API container, before introducing any candidate migration/schema changes.
docker run --rm --network "$db_network" -e DATABASE_URL="$compat_url" \
  "$source_api" /app/node_modules/.bin/prisma migrate deploy --schema prisma/schema.prisma

# Capture the actual *source* schema inventory before candidate migration,
# not an assumption that a particular future release always adds the same tables.
source_schema_inventory="$(docker exec "$db_container" psql -U resource_portal -d resource_portal -Atc \
  "SELECT string_agg(table_schema || '.' || table_name, ',' ORDER BY table_schema, table_name) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")"
[[ -n "$source_schema_inventory" ]] || { echo "Missing source schema inventory" >&2; exit 1; }

# The previous Prisma client creates real persistent tenant/user sentinels.
# New fields/tables may be additive, but old client reads and writes must work.
probe="${GITHUB_RUN_ID:-local}-${RANDOM}"
docker run --rm --network "$db_network" -e DATABASE_URL="$compat_url" \
  -e RP_ROLLBACK_PROBE="$probe" --entrypoint node "$source_api" -e '
  const { PrismaClient } = require("@prisma/client");
  const p = new PrismaClient();
  (async () => {
    const tenant=await p.tenant.create({data:{
      name:"rollback-probe-"+process.env.RP_ROLLBACK_PROBE,
      displayName:"Rollback test",contactEmail:"rollback@example.invalid"
    }});
    const user=await p.user.create({data:{
      email:"rollback-"+process.env.RP_ROLLBACK_PROBE+"@example.invalid",
      displayName:"Rollback test user",status:"Active"
    }});
    await p.portalSession.create({data:{
      id:"rollback-session-"+process.env.RP_ROLLBACK_PROBE,
      userId:user.id,
      accessToken:"synthetic-rollback-access",
      refreshToken:"synthetic-rollback-refresh",
      idToken:"synthetic-rollback-id",
      accessTokenExpiresAt:new Date(Date.now()+3600000),
      expiresAt:new Date(Date.now()+86400000)
    }});
    await p.oAuthApplication.create({data:{
      tenantId:tenant.id,name:"Legacy RP client",type:"Web",
      redirectUris:["https://rollback.example.invalid/callback"],postLogoutRedirectUris:[],
      zitadelApplicationId:"app-"+process.env.RP_ROLLBACK_PROBE,
      clientId:"client-"+process.env.RP_ROLLBACK_PROBE,
      createdBy:user.id,updatedBy:user.id
    }});
  })().then(()=>p.$disconnect(),e=>{console.error(e);process.exitCode=1;p.$disconnect()});
'

cat >"$root/previous-stack.yml" <<YAML
services:
  api:
    image: $source_api
    entrypoint: ["/bin/sh", "-c", "sleep 3600"]
    command: []
    deploy: {replicas: 1}
  web:
    image: $source_web
    entrypoint: ["/bin/sh", "-c", "sleep 3600"]
    command: []
    deploy: {replicas: 1}
  postgres:
    image: $source_postgres
    entrypoint: ["/bin/sh", "-c", "sleep 3600"]
    command: []
    deploy: {replicas: 1}
YAML
cat >"$root/target-stack.yml" <<'YAML'
services:
  api:
    image: resourceportal-api-candidate
    entrypoint: ["/bin/sh", "-c", "sleep 3600"]
    command: []
    deploy: {replicas: 1}
  web:
    image: resourceportal-web-candidate
    entrypoint: ["/bin/sh", "-c", "sleep 3600"]
    command: []
    deploy: {replicas: 1}
  postgres:
    image: resourceportal-postgres-candidate
    entrypoint: ["/bin/sh", "-c", "sleep 3600"]
    command: []
    deploy: {replicas: 1}
YAML

# Target manifest contains image IDs of the exact candidate binaries tested
# in this job. Public registry digests are not known until publication.
candidate_api="$(docker image inspect --format '{{.Id}}' resourceportal-api-candidate)"
candidate_web="$(docker image inspect --format '{{.Id}}' resourceportal-web-candidate)"
candidate_postgres="$(docker image inspect --format '{{.Id}}' resourceportal-postgres-candidate)"
jq --arg commit "$current_sha" --arg source "$source_version" \
   --arg api "$candidate_api" --arg web "$candidate_web" --arg postgres "$candidate_postgres" '
  .version="99.99.99"
  | .images.api=("ghcr.io/re-invertion/resourceportal-api@" + $api)
  | .images.web=("ghcr.io/re-invertion/resourceportal-web@" + $web)
  | .images.postgres=("ghcr.io/re-invertion/resourceportal-postgres@" + $postgres)
  | .migrations.rollbackPolicy="tested"
  | .migrations.rollbackAssessment={
      reason:"verified-recovery-test",
      sourceVersion:$source,targetCommit:$commit
    }
  | .migrations.rollbackEvidence={
      kind:"real-upgrade-and-restore", workflowRunId:1, sourceVersion:$source,
      databaseSnapshotRestored:true, restoredSourceSchema:true, zitadelDatabaseRestored:true
    }' "$root/previous-release.json" >"$root/target-release.json"
rp_validate_release_manifest "$root/target-release.json"
docker swarm init --advertise-addr "$(hostname -I | awk '{print $1}')" >/dev/null
swarm_started=true

service_images_match() {
  local phase="$1" role expected observed
  for role in api web postgres; do
    if [[ "$phase" == previous ]]; then
      expected="$(jq -er --arg role "$role" '.images[$role]' "$root/previous-release.json")"
    else
      expected="resourceportal-${role}-candidate:latest"
    fi
    observed="$(docker service inspect "${stack}_${role}" --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' 2>/dev/null)" || return 1
    [[ "$observed" == "$expected" ]] || {
      echo "Wrong $phase image for $role: expected $expected, got $observed" >&2
      return 1
    }
  done
}

wait_services() {
  local phase="$1" attempt role ready
  for ((attempt=0;attempt<90;attempt++)); do
    ready=true
    for role in api web postgres; do
      [[ "$(docker service ls --filter "name=${stack}_${role}" --format '{{.Replicas}}')" == "1/1" ]] || ready=false
    done
    if [[ "$ready" == true ]] && service_images_match "$phase"; then return 0; fi
    sleep 2
  done
  for role in api web postgres; do docker service ps --no-trunc "${stack}_${role}" >&2 || true; done
  echo "Rollback smoke services did not converge ($phase)" >&2
  return 1
}
docker stack deploy --compose-file "$root/previous-stack.yml" --with-registry-auth --prune "$stack" >/dev/null
wait_services previous

export RP_UPGRADE_STATE_DIR="$root/checkpoint"
export RP_INSTALLER_STATE_DIR="$root/installed"
export RP_UPGRADE_INSTALLER_CONFIG_FILE="$root/installer.conf"
export RP_UPGRADE_STACK_FILE="$root/installed-stack.yml"
export RP_CFG_RELEASE_VERSION="$source_version"
export RP_UPGRADE_SOURCE_VERSION="$source_version"
export RP_CFG_DOMAIN="rollback-smoke.invalid"
export RP_CFG_STACK_NAME="$stack"
export RP_CFG_ACME_ENVIRONMENT=production
mkdir -p "$RP_INSTALLER_STATE_DIR"
cp "$root/previous-release.json" "$RP_INSTALLER_STATE_DIR/release.json"
cp "$root/previous-stack.yml" "$RP_UPGRADE_STACK_FILE"
printf 'previous config\n' >"$RP_UPGRADE_INSTALLER_CONFIG_FILE"

# Only external platform dependencies are stubbed, not the upgrade or
# rollback state machine, checkpoints, Docker deployment or compatibility gate.
# The unsigned *candidate* manifest cannot yet have official release provenance.
rp_config_apply_defaults() { return 0; }
rp_verify_release_manifest_attestation() { return 0; }
rp_upgrade_identity_preflight() { return 0; }
rp_pull_release_images() { return 0; }
rp_apply_release_manifest_images() { return 0; }
rp_upgrade_ensure_v020_node_labels() { return 0; }
rp_upgrade_refresh_firewall() { return 0; }
rp_upgrade_quiesce_database_clients() { return 0; }
# Only fixture lookup is supplied here: production snapshot and restore code,
# including real pg_dump, pg_restore and journal checks, is never mocked.
rp_upgrade_database_task() {
  case "$1" in
    postgres-rp) printf '%s\n' "$db_container" ;;
    postgres-zitadel) printf '%s\n' "$zitadel_db_container" ;;
    *) return 1 ;;
  esac
}
rp_upgrade_prepare_postgres_services() { return 0; }
rp_upgrade_prepare_zitadel_for_mcp_oauth() { return 0; }
rp_run_zitadel_mcp_oauth_reconcile() { return 0; }
rp_run_migrations() {
  docker run --rm --network "$db_network" -e DATABASE_URL="$compat_url" \
    resourceportal-api-candidate /app/node_modules/.bin/prisma migrate deploy --schema prisma/schema.prisma
  # Assert the *new* relational schema was actually installed.
  local present
  present="$(docker exec "$db_container" psql -U resource_portal -d resource_portal -Atc \
    "SELECT (to_regclass('public.\"TenantOidcProvider\"') IS NOT NULL AND to_regclass('public.\"TenantOidcGrant\"') IS NOT NULL)::text")"
  [[ "$present" == true ]] || return 1
  docker exec "$zitadel_db_container" psql -U postgres -d zitadel -v ON_ERROR_STOP=1 \
    -c "UPDATE rollback_identity_probe SET marker = 'mutated'; CREATE TABLE candidate_zitadel_probe (id integer);" >/dev/null
}
rp_deploy_control_plane() {
  docker stack deploy --resolve-image never --compose-file "$root/target-stack.yml" \
    --with-registry-auth --prune "$stack" >/dev/null || return 1
  wait_services target || return 1
  # Simulate an update that overwrote persisted configuration prior to a
  # fatal post-deployment check. The actual rollback must restore it.
  printf 'target config\n' >"$RP_UPGRADE_INSTALLER_CONFIG_FILE"
  printf 'target stack\n' >"$RP_UPGRADE_STACK_FILE"
}
health_checks=0
rp_wait_for_https_origin() {
  health_checks=$((health_checks + 1))
  if [[ "$health_checks" -eq 1 ]]; then
    # Fail *inside rp_upgrade_apply*, after the candidate services converge.
    # The production entry point must call rollback itself.
    wait_services target || return 1
    echo "Injected target health-check failure" >&2
    return 1
  fi
  # The recovered service image digests and running replicas are real;
  # no pretend-healthy return value can mask incorrect restoration.
  wait_services previous
}

if rp_upgrade_apply "$root/target-release.json" "$root/previous-stack.yml"; then
  echo "Injected failed upgrade unexpectedly succeeded" >&2
  exit 1
fi
[[ "$health_checks" -eq 2 ]] || {
  echo "Upgrade entry point did not automatically invoke rollback health verification" >&2
  exit 1
}
[[ "$(jq -er .databaseSnapshotState "$RP_UPGRADE_STATE_DIR/state.json")" == "restored" ]] || {
  echo "Installer did not restore both database snapshots" >&2; exit 1;
}
# The candidate's schema and ZITADEL side effects MUST be absent after restore.
source_schema_restored="$(docker exec "$db_container" psql -U resource_portal -d resource_portal -Atc \
  "SELECT string_agg(table_schema || '.' || table_name, ',' ORDER BY table_schema, table_name) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")"
[[ "$source_schema_restored" == "$source_schema_inventory" ]] || { echo "Exact source schema inventory was NOT restored" >&2; exit 1; }
zitadel_restored="$(docker exec "$zitadel_db_container" psql -U postgres -d zitadel -Atc \
  "SELECT marker FROM rollback_identity_probe WHERE id = 1")"
[[ "$zitadel_restored" == original ]] || { echo "ZITADEL identity data was NOT restored" >&2; exit 1; }
zitadel_candidate_table="$(docker exec "$zitadel_db_container" psql -U postgres -d zitadel -Atc \
  "SELECT to_regclass('public.candidate_zitadel_probe') IS NULL")"
[[ "$zitadel_candidate_table" == t ]] || { echo "ZITADEL candidate schema was NOT removed" >&2; exit 1; }
[[ "$(jq -er .phase "$RP_UPGRADE_STATE_DIR/state.json")" == "rolled-back" ]]
wait_services previous
cmp -s "$root/previous-release.json" "$RP_INSTALLER_STATE_DIR/release.json"
cmp -s "$root/previous-stack.yml" "$RP_UPGRADE_STACK_FILE"
[[ "$(cat "$RP_UPGRADE_INSTALLER_CONFIG_FILE")" == "previous config" ]]

# Start the exact previous API image against the RESTORED source database,
# not just an inert "sleep" container. The readiness endpoint performs
# a real Prisma query and catches runtime bootstrap/dependency regressions that
# direct model access alone cannot detect.
docker run -d --name "$old_api_probe" --network "$db_network" \
  -e DATABASE_URL="$compat_url" -e NODE_ENV=test -e AUTH_MODE=dev \
  -e PORT=3000 -e PUBLIC_API_URL=http://127.0.0.1:3000 \
  -e RESOURCE_ENCRYPTION_KEY=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY= \
  -e INTERNAL_WORKER_TOKEN=rollback-smoke-test-only \
  "$source_api" >/dev/null
old_api_healthy=false
for ((attempt=0;attempt<60;attempt++)); do
  if docker exec "$old_api_probe" curl --fail --silent --show-error \
    --max-time 3 http://127.0.0.1:3000/api/health/ready >/dev/null 2>&1; then
    old_api_healthy=true
    break
  fi
  sleep 2
done
if [[ "$old_api_healthy" != true ]]; then
  docker logs "$old_api_probe" --tail 90 >&2 || true
  echo "Previous published API failed readiness against migrated database after rollback" >&2
  exit 1
fi
docker rm -f "$old_api_probe" >/dev/null

# Check *after* the injected failure and actual image rollback: the old API
# Prisma client must still read/update the rows created before migration.
# This certifies expand-only source/target compatibility, NOT SQL down-migrate.
docker run --rm --network "$db_network" -e DATABASE_URL="$compat_url" \
  -e RP_ROLLBACK_PROBE="$probe" --entrypoint node "$source_api" -e '
  const { PrismaClient, Prisma } = require("@prisma/client");
  const p = new PrismaClient();
  (async () => {
    // Query every model from the *previous published* Prisma client. This
    // checks every old relation/table/column, not just a selected happy path.
    for (const model of Prisma.dmmf.datamodel.models) {
      const accessor=model.name[0].toLowerCase()+model.name.slice(1);
      if (typeof p[accessor]?.findFirst !== "function") {
        throw new Error("Previous Prisma model unavailable: "+model.name);
      }
      try { await p[accessor].findFirst(); }
      catch(e) { throw new Error("Previous Prisma schema incompatible: "+model.name+" / "+e.message); }
    }
    const tenant = await p.tenant.findUniqueOrThrow({
      where:{name:"rollback-probe-"+process.env.RP_ROLLBACK_PROBE}
    });
    const user = await p.user.findUniqueOrThrow({
      where:{email:"rollback-"+process.env.RP_ROLLBACK_PROBE+"@example.invalid"}
    });
    if(tenant.displayName!=="Rollback test" || user.displayName!=="Rollback test user")
      throw new Error("Post-rollback data changed or disappeared");
    const updated=await p.tenant.update({
      where:{id:tenant.id},data:{displayName:"Rollback compatibility verified"}
    });
    if(updated.displayName!=="Rollback compatibility verified")throw new Error("Old Prisma client cannot write after rollback");
    const oldSession=await p.portalSession.findUniqueOrThrow({
      where:{id:"rollback-session-"+process.env.RP_ROLLBACK_PROBE}
    });
    if(oldSession.userId!==user.id || oldSession.revokedAt!==null ||
       oldSession.refreshToken!=="synthetic-rollback-refresh" ||
       oldSession.expiresAt.getTime()<=Date.now()) {
      throw new Error("Previous release session was lost or corrupted");
    }
    await p.portalSession.update({
      where:{id:oldSession.id},
      data:{lastSeenAt:new Date()}
    });
    const legacyClient=await p.oAuthApplication.findUniqueOrThrow({
      where:{clientId:"client-"+process.env.RP_ROLLBACK_PROBE}
    });
    if (legacyClient.name!=="Legacy RP client" ||
        JSON.stringify(legacyClient.redirectUris)!==JSON.stringify(["https://rollback.example.invalid/callback"])) {
      throw new Error("Previous release OAuth client data was corrupted");
    }
    await p.oAuthApplication.update({
      where:{id:legacyClient.id},data:{name:"Legacy client restored"}
    });
    await p.identityProvider.count();
  })().then(()=>p.$disconnect(),e=>{console.error(e);process.exitCode=1;p.$disconnect()});
'

# Only after every real test passes may a separate policy step consider proof
# bound to the exact SHA/version. Merely writing this file is never accepted
# without the current job having exited successfully.
if [[ -n "${RP_ROLLBACK_EVIDENCE_OUTPUT:-}" ]]; then
  jq -n --arg src "$source_version" --arg sha "$current_sha" \
    --argjson run "${GITHUB_RUN_ID:-0}" \
    '{kind:"real-upgrade-and-restore",sourceVersion:$src,targetCommit:$sha,workflowRunId:$run,
      actualDatabaseMigration:true,previousApiReadWriteAfterRollback:true,
      previousApiRuntimeReadyAfterRollback:true,
      injectedHealthFailure:true,previousImagesRestored:true,
      databaseSnapshotVerified:true,databaseSnapshotRestored:true,
      restoredSourceSchema:true,zitadelDatabaseRestored:true}' >"$RP_ROLLBACK_EVIDENCE_OUTPUT"
fi
echo "PASS: source RP/ZITADEL databases and schemas restored, prior images healthy, previous Prisma read/write verified after injected failure."
