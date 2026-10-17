import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const upgrade = readFileSync("scripts/installer/upgrade.sh", "utf8");
const smoke = readFileSync("scripts/run-automatic-rollback-smoke.sh", "utf8");
const policy = readFileSync("scripts/release-rollback-policy.mjs", "utf8");

test("source DB snapshots are taken after quiesce but before RP/ZITADEL migrations", () => {
  const q = upgrade.indexOf('rp_upgrade_quiesce_database_clients ||', upgrade.indexOf('rp_upgrade_apply()'));
  const snapshot = upgrade.indexOf('rp_upgrade_database_snapshot_prepare "$manifest" ||', q);
  const postgres = upgrade.indexOf('rp_upgrade_prepare_postgres_services ||', q);
  const zitadel = upgrade.indexOf('rp_run_zitadel_mcp_oauth_reconcile ||', q);
  const migration = upgrade.indexOf('rp_run_migrations ||', q);
  assert(q > 0 && snapshot > q && postgres > snapshot && zitadel > postgres && migration > zitadel);
});

test("database snapshots are atomically journaled and both database restores are mandatory before prior image deploy", () => {
  assert.match(upgrade, /sha256sum postgres-rp\.dump postgres-zitadel\.dump postgres-rp\.owner postgres-zitadel\.owner > SHA256SUMS/);
  assert.match(upgrade, /pg_restore --list/);
  assert.match(upgrade, /databaseSnapshotState="verified"/);
  assert.match(upgrade, /mktemp -d/);
  assert.match(upgrade, /databaseSnapshotDirectory/);
  assert.match(upgrade, /createdb -U "\$POSTGRES_USER" -T template0/);
  assert.match(upgrade, /pg_restore --exit-on-error --single-transaction/);
  assert.doesNotMatch(upgrade, /pg_restore --no-owner|pg_restore --no-privileges/);
  assert.match(upgrade, /ALTER DATABASE/);
  assert.match(upgrade, /RP_RESTORE_QUARANTINE/);
  const rollback = upgrade.slice(upgrade.indexOf("rp_upgrade_restore_after_failure()"));
  assert(rollback.indexOf("rp_upgrade_database_restore") < rollback.indexOf('docker stack deploy --compose-file'));
  assert.match(rollback, /rp_upgrade_checkpoint_phase rollback-failed/);
});

test("rollout smoke verifies exact source schemas and ZITADEL data rather than image compatibility alone", () => {
  assert.match(smoke, /zitadel_db_container/);
  assert.match(smoke, /rollback_identity_probe/);
  assert.match(smoke, /source_schema_restored/);
  assert.match(smoke, /zitadel_restored/);
  assert.match(smoke, /databaseSnapshotState/);
  assert.match(smoke, /restoredSourceSchema:true,zitadelDatabaseRestored:true/);
  assert.match(policy, /evidence\.databaseSnapshotRestored === true/);
  assert.match(policy, /evidence\.zitadelDatabaseRestored === true/);
});

test("a failed real database restore never redeploys previous API/images or claims a successful rollback", () => {
  const run = spawnSync("bash", ["-c", `
    set -euo pipefail
    source scripts/installer/upgrade.sh
    rp_upgrade_rollback_allowed() { return 0; }
    rp_manifest_value() { printf 'tested\\n'; }
    checkpoint="$(mktemp -d)"
    trap 'rm -rf "$checkpoint"' EXIT
    printf '{"databaseSnapshotState":"verified","runtimeStage":"postgres-rollout"}' >"$checkpoint/state.json"
    RP_UPGRADE_ACTIVE_CHECKPOINT="$checkpoint"
    rp_upgrade_checkpoint_phase() { printf 'phase:%s\\n' "$1"; }
    rp_upgrade_database_restore() { return 1; }
    docker() { printf 'DANGEROUS_DOCKER_CALLED\\n'; return 0; }
    rp_upgrade_restore_after_failure /tmp/dummy /tmp/previous failed-step
  `], { encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /phase:rollback-failed/);
  assert.doesNotMatch(run.stdout, /DANGEROUS_DOCKER_CALLED/);
});

test("the DB source backup fails closed when a local database task cannot be identified", () => {
  const run = spawnSync("bash", ["-c", `
    set -euo pipefail
    source scripts/installer/upgrade.sh
    state="$(mktemp -d)"
    trap 'rm -rf "$state"' EXIT
    printf '{}' >"$state/state.json"
    RP_UPGRADE_ACTIVE_CHECKPOINT="$state"
    rp_manifest_value() { printf 'tested\\n'; }
    rp_upgrade_database_task() { return 1; }
    rp_upgrade_database_snapshot_prepare /tmp/manifest
  `], { encoding: "utf8" });
  assert.equal(run.status, 1);
});

test("live candidate and published ZITADEL must boot real eventstore before signed release evidence", () => {
  const runtime = readFileSync("scripts/rollback-zitadel-runtime.sh", "utf8");
  const readiness = readFileSync(".github/workflows/release-readiness.yml", "utf8");
  const publication = readFileSync(".github/workflows/release.yml", "utf8");
  assert.match(smoke, /docker pull "\$source_zitadel"/);
  assert.match(smoke, /rp_rollback_zitadel_start "\$source_zitadel" "published source"/);
  assert.match(smoke, /rp_rollback_zitadel_start "\$candidate_zitadel" "release candidate"/);
  assert.match(smoke, /rp_rollback_zitadel_verify_restored_source \|\| exit 1/);
  assert(smoke.indexOf("rp_rollback_zitadel_verify_restored_source || exit 1") <
    smoke.indexOf("RP_ROLLBACK_EVIDENCE_OUTPUT"));
  assert.match(runtime, /start-from-init/);
  assert.match(runtime, /\.well-known\/openid-configuration/);
  assert.match(runtime, /eventstore\.events2/);
  assert.match(runtime, /zitadel_source_schema_inventory/);
  assert.match(runtime, /zitadel_source_events/);
  assert.match(runtime, /rp_rollback_zitadel_event_fingerprints/);
  assert.match(runtime, /comm -23/);
  assert.match(runtime, /row_to_json\(e\)/);
  assert.match(smoke, /candidateZitadelImage:\$zitadel_candidate/);
  assert.match(smoke, /candidateZitadelImage:\$zitadel/);
  assert.match(publication, /ZITADEL_REF="\$\(jq -er '.candidateZitadelImage'/);
  assert.match(publication, /docker pull "\$ZITADEL_REF"/);
  assert.match(runtime, /\.Config.Image/);
  assert.match(readiness, /RP_ROLLBACK_CANDIDATE_ZITADEL_IMAGE: ghcr.io\/zitadel\/zitadel:v4\.17\.0/);
  assert.match(publication, /ghcr.io\/zitadel\/zitadel:v4\.17\.0/);
  assert.match(publication, /RP_ROLLBACK_CANDIDATE_ZITADEL_IMAGE: ghcr.io\/zitadel\/zitadel:v4\.17\.0/);
  assert.match(policy, /evidence\.zitadelSourceRuntimeReadyAfterRollback === true/);
  assert.match(policy, /evidence\.zitadelSourceEventstoreVerified === true/);
  assert.match(policy, /evidence\.candidateZitadelRuntimeReadyBeforeRollback === true/);
  assert.match(smoke, /candidateZitadelRuntimeReadyBeforeRollback:true/);
  assert.match(smoke, /zitadelSourceRuntimeReadyAfterRollback:true/);
});
test("ZITADEL shadow DB restore preserves original eventstore table owners", () => {
  assert.match(upgrade, /role" == postgres-zitadel/);
  assert.doesNotMatch(upgrade, /RP_RESTORE_NO_OWNER/);
  assert.match(smoke, /GRANT SELECT ON public\."Tenant" TO rollback_rp_reader/);
  assert.match(smoke, /GRANT SELECT ON eventstore\.events2 TO rollback_zitadel_reader/);
  assert.match(smoke, /has_table_privilege\('rollback_rp_reader'/);
  assert.match(smoke, /has_table_privilege\('rollback_zitadel_reader'/);
  assert.match(upgrade, /postgres-rp.owner postgres-zitadel.owner > SHA256SUMS/);
  assert.match(upgrade, /RP_RESTORE_OWNER/);
  assert.match(upgrade, /ALTER DATABASE/);
  assert.match(upgrade, /exec pg_restore --exit-on-error --single-transaction/);
});
test("live ZITADEL rollback refuses non-ephemeral CI and missing pinned release image", () => {
  const bad = spawnSync("bash", ["-c",
    "source scripts/rollback-zitadel-runtime.sh; GITHUB_ACTIONS=false; RP_ROLLBACK_E2E_ISOLATED=false; rp_rollback_zitadel_prepare",
  ], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Refusing ZITADEL rollback test/);
  const missing = spawnSync("bash", ["-c",
    "source scripts/rollback-zitadel-runtime.sh; GITHUB_ACTIONS=true; RP_ROLLBACK_E2E_ISOLATED=true; unset RP_ROLLBACK_CANDIDATE_ZITADEL_IMAGE; rp_rollback_zitadel_prepare",
  ], { encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /explicitly selected release tag/);
});

test("signed tested manifest rejects a ZITADEL digest different from the live rollback evidence", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "rp-zitadel-proof-"));
  const img = (name, digest) => name + "@sha256:" + digest.repeat(64);
  const candidate = img("ghcr.io/zitadel/zitadel", "d");
  const manifest = {
    schemaVersion: 1, version: "99.99.99",
    installer: { minimumVersion: "0.1.0" },
    docker: { minimumVersion: "27.0.0" },
    configSchemaVersion: 1,
    images: {
      api: img("ghcr.io/re-invertion/resourceportal-api", "a"),
      web: img("ghcr.io/re-invertion/resourceportal-web", "b"),
      postgres: img("ghcr.io/re-invertion/resourceportal-postgres", "c"),
      zitadel: candidate, traefik: img("traefik", "e"),
    },
    migrations: {
      supportedFromVersions: ["0.2.86"], rollbackPolicy: "tested",
      rollbackAssessment: { reason: "verified-recovery-test", sourceVersion: "0.2.86", targetCommit: "a".repeat(40) },
      rollbackEvidence: {
        kind: "real-upgrade-and-restore", sourceVersion: "0.2.86",
        workflowRunId: 400, candidateZitadelImage: candidate,
      },
    },
  };
  const file = join(directory, "manifest.json");
  const check = () => spawnSync("bash", ["-c",
    'source scripts/installer/releases.sh; rp_validate_release_manifest "$1"', "validate", file,
  ], { encoding: "utf8" }).status;
  try {
    writeFileSync(file, JSON.stringify(manifest));
    assert.equal(check(), 0, "matching attested digest must be accepted");
    manifest.migrations.rollbackEvidence.candidateZitadelImage = img("ghcr.io/zitadel/zitadel", "f");
    writeFileSync(file, JSON.stringify(manifest));
    assert.notEqual(check(), 0, "a different image MUST NOT be signed as tested");
    delete manifest.migrations.rollbackEvidence.candidateZitadelImage;
    writeFileSync(file, JSON.stringify(manifest));
    assert.notEqual(check(), 0, "a missing image proof MUST NOT be accepted");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
