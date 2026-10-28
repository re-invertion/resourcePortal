import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
function preflight(missing) {
  const root = mkdtempSync(join(tmpdir(), "rp-preflight-test-"));
  const pat = join(root, "admin.pat"); writeFileSync(pat, "fixture-pat");
  try {
    return spawnSync("bash", ["-c", `
set -eu
source scripts/installer/upgrade.sh
source scripts/installer/identity.sh
RP_ZITADEL_MANAGEMENT_PAT_FILE="$PAT"
RP_CFG_ZITADEL_ORGANIZATION_ID=org-test
RP_CFG_ZITADEL_PROJECT_ID=project-test
RP_CFG_ZITADEL_MANAGEMENT_SWARM_REF=rp_management_test
RP_CFG_ZITADEL_DOMAIN=auth.example.test
case "$MISSING" in pat) RP_ZITADEL_MANAGEMENT_PAT_FILE="$PAT-absent";; org) unset RP_CFG_ZITADEL_ORGANIZATION_ID;; esac
docker() { [[ "$1 $2 $3" == "secret inspect rp_encryption_key" && "$MISSING" != secret ]]; }
rp_upgrade_identity_preflight
`], { encoding: "utf8", env: { ...process.env, PAT: pat, MISSING: missing } });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

for (const stage of ["quiescing-clients", "postgres-rollout", "zitadel-rollout", "mcp-oauth-reconciliation", "resourceportal-migrations-started", "target-stack-healthy", "completed"]) {
  for (const policy of ["allowed", "revoked"]) {
    test(`checkpoint failure at ${stage} follows guarded recovery (${policy})`, () => {
      const result = spawnSync("bash", ["-c", `
set -eu
source scripts/installer/upgrade.sh
RP_CFG_DOMAIN=example.test
RP_CFG_RELEASE_VERSION=0.2.78
rp_upgrade_check_temporary_files(){ :; }
rp_config_apply_defaults(){ :; }
rp_verify_release_manifest_attestation(){ :; }
rp_upgrade_identity_preflight(){ :; }
rp_pull_release_images(){ :; }
rp_apply_release_manifest_images(){ :; }
rp_upgrade_checkpoint_prepare(){ :; }
rp_upgrade_database_snapshot_prepare(){ :; }
rp_manifest_value(){ printf '0.2.81'; }
rp_upgrade_ensure_v020_node_labels(){ :; }
rp_upgrade_refresh_firewall(){ :; }
rp_upgrade_checkpoint_stage(){ printf 'STAGE:%s\\n' "$1"; [[ "$1" != "$FAIL_STAGE" ]]; }
rp_upgrade_checkpoint_phase(){ printf 'PHASE:%s\\n' "$1"; [[ "$1" != "$FAIL_STAGE" ]]; }
rp_upgrade_quiesce_database_clients(){ printf 'QUIESCE\\n'; }
rp_upgrade_prepare_postgres_services(){ printf 'POSTGRES\\n'; }
rp_upgrade_prepare_zitadel_for_mcp_oauth(){ printf 'ZITADEL\\n'; }
rp_run_zitadel_mcp_oauth_reconcile(){ printf 'OAUTH\\n'; }
rp_run_migrations(){ printf 'MIGRATE\\n'; }
rp_deploy_control_plane(){ printf 'DEPLOY\\n'; }
rp_wait_for_https_origin(){ :; }
rp_upgrade_wait_for_tenant_oidc_ready(){ :; }
rp_upgrade_refresh_enrollment_listener(){ :; }
rp_persist_release_manifest(){ printf '/etc/hosts'; }
rp_config_write(){ :; }
rp_write_stack(){ :; }
RP_TEST_ROLLBACK_CHECKS=0
rp_upgrade_rollback_allowed(){
  RP_TEST_ROLLBACK_CHECKS=$((RP_TEST_ROLLBACK_CHECKS + 1))
  [[ "$POLICY" != revoked || "$RP_TEST_ROLLBACK_CHECKS" == 1 ]]
}
rp_upgrade_source_rollback_policy(){ printf 'image-only\\n'; }
rp_upgrade_database_restore(){ printf 'DB-RESTORE\\n'; }
rp_swarm_stack_deploy_retry(){ printf 'ROLLBACK\\n'; }
rp_ensure_rollback_agent_capabilities(){ :; }
rp_upgrade_restore_manifest_checkpoint(){ :; }
docker(){ printf 'UNEXPECTED-DOCKER\\n'; return 1; }
if rp_upgrade_apply /etc/hosts /etc/hosts; then exit 99; else exit 1; fi
`], { encoding: "utf8", env: { ...process.env, FAIL_STAGE: stage, POLICY: policy } });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /ResourcePortal update failed at checkpoint/);
      if (policy === "revoked") {
        assert.match(result.stdout, /PHASE:manual-recovery-required/);
        assert.doesNotMatch(result.stdout, /ROLLBACK|DB-RESTORE/);
        assert.match(result.stderr, /Automatic rollback refused/);
      } else {
        assert.match(result.stdout, /PHASE:rolling-back\nDB-RESTORE\nROLLBACK\nPHASE:rolled-back/);
      }
      assert.doesNotMatch(result.stdout, /UNEXPECTED-DOCKER/);
      const next = { "quiescing-clients": "QUIESCE", "postgres-rollout": "POSTGRES", "zitadel-rollout": "ZITADEL", "mcp-oauth-reconciliation": "OAUTH", "resourceportal-migrations-started": "MIGRATE" }[stage];
      if (next) assert.doesNotMatch(result.stdout, new RegExp(`^${next}$`, "m"));
    });
  }
}
test("rollback policy without automatic recovery is rejected before any image pull or runtime mutation", () => {
  const result = spawnSync("bash", ["-c", `
set -eu
source scripts/installer/upgrade.sh
rp_upgrade_check_temporary_files(){ :; }
rp_config_apply_defaults(){ :; }
rp_verify_release_manifest_attestation(){ :; }
rp_upgrade_rollback_allowed(){ return 1; }
rp_upgrade_identity_preflight(){ printf 'UNSAFE-IDENTITY'; }
rp_pull_release_images(){ printf 'UNSAFE-PULL'; }
rp_upgrade_quiesce_database_clients(){ printf 'UNSAFE-QUIESCE'; }
rp_upgrade_apply /etc/hosts /etc/hosts
`], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release manifest does not guarantee automatic rollback/);
  assert.doesNotMatch(result.stdout, /UNSAFE/);
});

test("identity preflight accepts available identity metadata, PAT and secret reference", () => {
  const result = preflight(""); assert.equal(result.status, 0, result.stderr);
});
for (const missing of ["pat", "org", "secret"]) {
  test("identity preflight blocks a missing " + missing + " with an actionable error", () => {
    const result = preflight(missing);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Upgrade identity preflight/);
    assert.doesNotMatch(result.stderr, /fixture-pat/);
  });
}
test("identity preflight fails before any running service is changed", () => {
  const result = spawnSync("bash", ["-c", `
set -eu
source scripts/installer/upgrade.sh
rp_upgrade_check_temporary_files(){ return 0; }
rp_config_apply_defaults(){ return 0; }
rp_verify_release_manifest_attestation(){ return 0; }
rp_upgrade_rollback_allowed(){ return 0; }
rp_upgrade_identity_preflight(){ printf 'missing secret\\n' >&2; return 1; }
rp_upgrade_quiesce_database_clients(){ printf 'UNSAFE-QUIESCE'; }
rp_pull_release_images(){ printf 'UNSAFE-PULL'; }
rp_upgrade_apply /etc/hosts /etc/hosts
`], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing secret/);
  assert.doesNotMatch(result.stdout, /UNSAFE/);
});
test("failure checkpoint retains the last runtime stage without permitting unsafe rollback", () => {
  const root = mkdtempSync(join(tmpdir(), "rp-stage-test-"));
  writeFileSync(join(root, "state.json"), JSON.stringify({ phase: "applying" }));
  try {
    const result = spawnSync("bash", ["-c", `
set -eu
source scripts/installer/upgrade.sh
RP_UPGRADE_ACTIVE_CHECKPOINT="$STATE_DIR"
rp_upgrade_checkpoint_stage mcp-oauth-reconciliation
rp_upgrade_rollback_allowed(){ return 1; }
docker(){ printf 'UNSAFE-ROLLBACK'; }
rp_upgrade_restore_after_failure /etc/hosts /etc/hosts 'MCP OAuth reconciliation' || true
jq -e '.phase == "manual-recovery-required" and .runtimeStage == "mcp-oauth-reconciliation" and .errorCode == "UpgradeStepFailed"' "$STATE_DIR/state.json"
`], { encoding: "utf8", env: { ...process.env, STATE_DIR: root } });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /UNSAFE/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
