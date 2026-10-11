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
