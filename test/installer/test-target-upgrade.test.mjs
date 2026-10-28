import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const launcher = resolve("scripts/installer/target-upgrade.sh");
const digest = (role, char) => role + "@sha256:" + char.repeat(64);
function run(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "rp-target-test-"));
  const manifest = {
    schemaVersion: 1, version: "0.2.81",
    installer: { minimumVersion: "0.1.0" }, docker: { minimumVersion: "27.0.0" },
    configSchemaVersion: 1,
    images: {
      api: digest("ghcr.io/re-invertion/resourceportal-api", "a"),
      web: digest("ghcr.io/re-invertion/resourceportal-web", "b"),
      postgres: digest("ghcr.io/re-invertion/resourceportal-postgres", "c"),
      zitadel: digest("ghcr.io/zitadel/zitadel", "d"), traefik: digest("traefik", "e"),
    },
    migrations: { supportedFromVersions: ["0.2.78"], rollbackPolicy: "none" },
    ...overrides.manifest,
  };
  writeFileSync(join(root, "manifest"), JSON.stringify(manifest));
  const log = join(root, "docker.log");
  const executable = (name, content) => writeFileSync(join(root, name), "#!/bin/bash\nset -eu\n" + content, { mode: 0o755 });
  executable("curl", 'while [[ "$1" != -o ]]; do shift; done; cp "$FIXTURE_MANIFEST" "$2"\n');
  executable("gh", 'printf "verified\\n" >> "$DOCKER_LOG"; exit "${VERIFY_EXIT:-0}"\n');
  executable("docker", 'printf "%s\\n" "$*" >> "$DOCKER_LOG"; case "$1" in inspect) if [[ "${2:-}" == rp-test-target && "${3:-}" == --format ]]; then printf "%s\\n" "${START_STATE:-created}"; else exit 1; fi;; start) exit "${START_EXIT:-0}";; wait) printf "%s\\n" "${CHILD_EXIT:-0}";; esac\n');
  // The official verifier must still see a non-empty bundle.
  writeFileSync(join(root, "bundle"), "{}");
  try {
    const result = spawnSync("bash", [launcher], {
      encoding: "utf8",
      env: {
        ...process.env, PATH: root + ":" + process.env.PATH,
        FIXTURE_MANIFEST: join(root, "manifest"), DOCKER_LOG: log,
        RP_RELEASE_ATTESTATION_BUNDLE: join(root, "bundle"),
        RP_TARGET_VERSION: "0.2.81",
        RP_TARGET_MANIFEST_URL: "https://github.com/re-invertion/resourcePortal/releases/download/v0.2.81/resourceportal-release-manifest.json",
        RP_TARGET_CONTAINER: "rp-test-target",
        RP_UPDATER_STORAGE_BASE: "/srv/resource-portal/storage", RP_UPDATER_STORAGE_DEVICE: "/dev/vdb",
        ...overrides.env,
      },
    });
    let commands = ""; try { commands = readFileSync(log, "utf8"); } catch {}
    return { ...result, commands };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
test("old supervisor launches the installer from the verified target digest", () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.commands, /create.*ghcr\.io\/re-invertion\/resourceportal-api@sha256:a{64}/);
  assert.ok(result.commands.indexOf("verified") < result.commands.indexOf("create"));
  assert.match(result.commands, /RP_INSTALLER_VERSION=0\.2\.81/);
  assert.match(result.commands, /cp .*rp-test-target:\/tmp\/resourceportal-release-manifest.json/);
  assert.match(result.commands, /wait rp-test-target/);
});
test("manifest version mismatch fails before creating a privileged target", () => {
  const result = run({ manifest: { version: "0.2.80" } });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.commands, /create|pull|start/);
});
test("untrusted image fails before creating a privileged target", () => {
  const result = run({ manifest: { images: { api: digest("evil.example/api", "a") } } });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.commands, /create|pull|start/);
});
test("signature verification failure leaves workloads untouched", () => {
  const result = run({ env: { VERIFY_EXIT: "1" } });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.commands, /create|pull|start/);
});
test("target failure propagates and preserves the container for diagnosis", () => {
  const result = run({ env: { CHILD_EXIT: "1" } });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.commands, /rm rp-test-target/);
});
test("noncanonical URL fails before network or Docker activity", () => {
  const result = run({ env: { RP_TARGET_MANIFEST_URL: "https://github.com/evil/release" } });
  assert.notEqual(result.status, 0);
  assert.equal(result.commands, "");
});

test("Docker startup failure returns without waiting on an unstarted container", () => {
  const result = run({ env: { START_EXIT: "1", START_STATE: "created" } });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.commands, /wait rp-test-target|rm rp-test-target/);
});
test("attach failure still propagates the exit status of an exited target", () => {
  const result = run({ env: { START_EXIT: "1", START_STATE: "exited", CHILD_EXIT: "1" } });
  assert.notEqual(result.status, 0);
  assert.match(result.commands, /wait rp-test-target/);
});

function pullFixture(failures, message, timeoutCode) {
  const root = mkdtempSync(join(tmpdir(), "rp-pull-retry-"));
  const counter = join(root, "attempts");
  writeFileSync(counter, "0");
  writeFileSync(join(root, "docker"), `#!/bin/bash
n=$(cat "$COUNTER"); n=$((n+1)); echo "$n" > "$COUNTER"
if ((n <= FAILURES)); then echo "$FAILURE_MESSAGE" >&2; exit 1; fi
`, {mode: 0o755});
  writeFileSync(join(root, "sleep"), "#!/bin/bash\nexit 0\n", {mode: 0o755});
  if (timeoutCode) writeFileSync(join(root, "timeout"), `#!/bin/bash
n=$(cat "$COUNTER"); echo "$((n+1))" > "$COUNTER"; exit ${timeoutCode}
`, {mode: 0o755});
  try {
    const result = spawnSync("bash", ["-c", `source scripts/installer/common.sh; rp_pull_image_with_retry '${digest("ghcr.io/re-invertion/resourceportal-api", "a")}'`], {
      encoding: "utf8", env: {...process.env, PATH: root + ":" + process.env.PATH, COUNTER: counter, FAILURES: String(failures), FAILURE_MESSAGE: message},
    });
    return {...result, attempts: Number(readFileSync(counter, "utf8"))};
  } finally { rmSync(root, {recursive: true, force: true}); }
}
test("transient image-download failure gets a fresh Docker pull before succeeding (#366)", () => {
  const r = pullFixture(1, "Get https://pkg-containers.githubusercontent.com/blob?sig=secret: net/http: timeout awaiting response headers");
  assert.equal(r.status, 0, r.stderr); assert.equal(r.attempts, 2);
  assert.doesNotMatch(r.stderr, /sig=secret/);
});
test("image-download retries are bounded and preserve a failing exit status", () => {
  const r = pullFixture(9, "net/http: timeout awaiting response headers");
  assert.notEqual(r.status, 0); assert.equal(r.attempts, 3);
});
test("authentication failures are actionable and are not blindly retried", () => {
  const r = pullFixture(9, "unauthorized: authentication required");
  assert.notEqual(r.status, 0); assert.equal(r.attempts, 1);
  assert.match(r.stderr, /unauthorized/);
});

for (const code of [124, 137, 143]) test(`image-download watchdog status ${code} gets exactly three bounded attempts`, () => {
  const r = pullFixture(9, "", code);
  assert.notEqual(r.status, 0); assert.equal(r.attempts, 3);
});
