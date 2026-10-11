import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
function checkpoint(change = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rp-recovery-test-"));
  const stack = "services: {}\n";
  const hash = s => createHash("sha256").update(s).digest("hex");
  const manifest = JSON.stringify({ version: "0.2.81" });
  writeFileSync(join(dir, "previous-stack.yml"), stack);
  writeFileSync(join(dir, "previous-installed-stack.yml"), stack);
  writeFileSync(join(dir, "installed-stack.yml"), stack);
  writeFileSync(join(dir, "previous-installer.conf"), "RP_CFG_RELEASE_VERSION=0.2.78\n");
  writeFileSync(join(dir, "installer.conf"), "RP_CFG_RELEASE_VERSION=0.2.78\n");
  writeFileSync(join(dir, "previous-release.json"), JSON.stringify({ version: "0.2.78" }));
  writeFileSync(join(dir, "installed-release.json"), JSON.stringify({ version: "0.2.78" }));
  writeFileSync(join(dir, "target.json"), manifest);
  writeFileSync(join(dir, "state.json"), JSON.stringify({
    phase: "manual-recovery-required", sourceVersion: "0.2.78", targetVersion: "0.2.81",
    lastStep: "MCP OAuth reconciliation", configExists: true, manifestExists: true,
    previousStackSha256: hash(stack), targetManifestSha256: hash(manifest), ...change,
  }));
  return dir;
}
function verify(dir) {
  return spawnSync("bash", ["-c", `
set -eu
source scripts/installer/recovery.sh
rp_recovery_verify_checkpoint "$DIR" "$DIR/target.json" "$DIR/installed-release.json" "$DIR/installer.conf" "$DIR/installed-stack.yml"
`], { encoding: "utf8", env: { ...process.env, DIR: dir } });
}
test("recovery accepts only the unchanged recorded pre-migration OAuth failure", () => {
  const dir = checkpoint();
  try { const r = verify(dir); assert.equal(r.status, 0, r.stderr); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});
for (const change of [
  { phase: "applying" }, { targetVersion: "0.2.82" }, { sourceVersion: "0.2.77" },
  { lastStep: "migration/deployment health" }, { runtimeStage: "resourceportal-migrations-started" },
  { previousStackSha256: "0".repeat(64) }, { targetManifestSha256: "0".repeat(64) },
]) {
  test("recovery rejects unsafe checkpoint " + JSON.stringify(change), () => {
    const dir = checkpoint(change);
    try { const r = verify(dir); assert.notEqual(r.status, 0); assert.match(r.stderr, /Recovery refused/); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
test("recovery refuses changed installed configuration", () => {
  const dir = checkpoint();
  writeFileSync(join(dir, "installer.conf"), "RP_CFG_RELEASE_VERSION=0.2.82\n");
  try { const r = verify(dir); assert.notEqual(r.status, 0); assert.match(r.stderr, /Recovery refused/); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});
test("recovery journal preparation refuses unverified backups and preserves the original", () => {
  const dir = checkpoint();
  try {
    const r = spawnSync("bash", ["-c", `
set -eu
source scripts/installer/recovery.sh
rp_recovery_archive_checkpoint "$DIR" "$DIR/no-backup"
`], { encoding: "utf8", env: { ...process.env, DIR: dir } });
    assert.notEqual(r.status, 0);
    assert.equal(verify(dir).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("verified backup archives original checkpoint without rewriting its contents", () => {
  const dir = checkpoint();
  try {
    const r = spawnSync("bash", ["-c", `
set -eu
source scripts/installer/recovery.sh
mkdir "$DIR-backup"
trap 'rm -rf -- "$DIR-backup"' EXIT
for f in resourceportal.dump zitadel.dump host-state.tar.gz; do printf fixture > "$DIR-backup/$f"; done
(cd "$DIR-backup"; sha256sum resourceportal.dump zitadel.dump host-state.tar.gz > SHA256SUMS)
cp "$DIR/state.json" "$DIR/expected-state.json"
rp_recovery_archive_checkpoint "$DIR" "$DIR-backup"
cmp "$DIR/expected-state.json" "$DIR-backup/original-checkpoint/state.json"
cmp "$DIR/expected-state.json" "$DIR/state.json"
`], { encoding: "utf8", env: { ...process.env, DIR: dir } });
    assert.equal(r.status, 0, r.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("checkpoint archival leaves the unresolved active guard intact before target startup", () => {
  const dir = checkpoint();
  try {
    const r = spawnSync("bash", ["-c", `
set -eu
source scripts/installer/recovery.sh
mkdir "$DIR-backup"
trap 'rm -rf -- "$DIR-backup"' EXIT
for f in resourceportal.dump zitadel.dump host-state.tar.gz; do printf fixture > "$DIR-backup/$f"; done
(cd "$DIR-backup"; sha256sum resourceportal.dump zitadel.dump host-state.tar.gz > SHA256SUMS)
rp_recovery_archive_checkpoint "$DIR" "$DIR-backup"
rp_recovery_verify_checkpoint "$DIR" "$DIR/target.json" "$DIR/installed-release.json" "$DIR/installer.conf" "$DIR/installed-stack.yml"
`], { encoding: "utf8", env: { ...process.env, DIR: dir } });
    assert.equal(r.status, 0, r.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("target takeover is atomic, retains source snapshots and refuses concurrent/replayed ownership", () => {
  const dir = checkpoint();
  try {
    const r = spawnSync("bash", ["-c", `
set -eu
source scripts/installer/recovery.sh
mkdir "$DIR-backup"
trap 'rm -rf -- "$DIR-backup"' EXIT
for f in resourceportal.dump zitadel.dump host-state.tar.gz; do printf fixture > "$DIR-backup/$f"; done
(cd "$DIR-backup"; sha256sum resourceportal.dump zitadel.dump host-state.tar.gz > SHA256SUMS)
rp_recovery_archive_checkpoint "$DIR" "$DIR-backup"
export RP_UPGRADE_STATE_DIR="$DIR" RP_INSTALLER_STATE_DIR="$DIR"
export RP_UPGRADE_INSTALLER_CONFIG_FILE="$DIR/installer.conf" RP_UPGRADE_STACK_FILE="$DIR/installed-stack.yml"
cp "$DIR/installed-release.json" "$DIR/release.json"
export RP_RECOVERY_BACKUP="$DIR-backup"
export RP_RECOVERY_CHECKPOINT_SHA256="$(sha256sum "$DIR/state.json" | cut -d' ' -f1)"
exec {held}>"$DIR/lock"
flock -n "$held"
if (rp_recovery_prepare_checkpoint "$DIR/target.json" "$DIR/previous-stack.yml" 0.2.78); then exit 10; fi
cmp "$DIR/state.json" "$DIR-backup/original-checkpoint/state.json"
flock -u "$held"
exec {held}>&-
# A fresh process assumes ownership and releases its lock at process exit.
(rp_recovery_prepare_checkpoint "$DIR/target.json" "$DIR/previous-stack.yml" 0.2.78)
jq -e '.phase == "prepared" and .recovery.originalCheckpointSha256 != null' "$DIR/state.json" >/dev/null
cmp "$DIR/previous-stack.yml" "$DIR-backup/original-checkpoint/previous-stack.yml"
if (rp_recovery_prepare_checkpoint "$DIR/target.json" "$DIR/previous-stack.yml" 0.2.78); then exit 11; fi
`], { encoding: "utf8", env: { ...process.env, DIR: dir } });
    assert.equal(r.status, 0, r.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
