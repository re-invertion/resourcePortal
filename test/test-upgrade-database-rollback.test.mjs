import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const upgrade = readFileSync("scripts/installer/upgrade.sh", "utf8");
const smoke = readFileSync("scripts/run-automatic-rollback-smoke.sh", "utf8");
const policy = readFileSync("scripts/release-rollback-policy.mjs", "utf8");
const testedImagePublication = readFileSync("scripts/publish-tested-release-image.sh", "utf8");

test("each rollback source has an isolated Swarm stack and database volumes", () => {
  const declaration = smoke.split("\n").find((line) => line.startsWith('stack="rp-rollback-gate-'));
  assert.ok(declaration);
  const probe = spawnSync("bash", ["-c", [
    "set -euo pipefail",
    "GITHUB_RUN_ID=1234567",
    'source_version="0.2.92"',
    declaration,
    'printf "%s\\n" "$stack"',
    'source_version="0.2.93"',
    declaration,
    'printf "%s\\n" "$stack"',
    'source_version="0.2.94"',
    declaration,
    'printf "%s\\n" "$stack"',
  ].join("\n")], { encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  const names = probe.stdout.trim().split("\n");
  assert.equal(names.length, 3);
  assert.equal(new Set(names).size, 3, "each source must have isolated service, network and volume names");
  assert.ok(names.every((name) => /^rp-rollback-gate-1234567-0-2-9[234]$/.test(name)));
  assert.match(smoke, /db_volume_rp="\$\{stack\}-rp-postgres-data"/);
  assert.match(smoke, /db_volume_zitadel="\$\{stack\}-zitadel-postgres-data"/);
});

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
  assert(rollback.indexOf("rp_upgrade_database_restore") < rollback.indexOf('rp_swarm_stack_deploy_retry "$rollback_stack"'));
  assert.match(rollback, /rp_swarm_stack_deploy_retry/);
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


test("release publishes the exact previously tested local API/Web/Postgres image IDs, never rebuilding with Buildx", () => {
  const publication = readFileSync(".github/workflows/release.yml", "utf8");
  assert.doesNotMatch(publication, /docker\/build-push-action@/);
  for (const role of ["api", "web", "postgres"]) {
    assert.match(publication, new RegExp("scripts/publish-tested-release-image\\.sh " + role));
  }
  assert.match(testedImagePublication, /resourceportal-\$role-candidate/);
  assert.match(testedImagePublication, /docker tag "\$candidate" "\$published"/);
  assert.match(testedImagePublication, /docker push "\$published"/);
  assert.match(testedImagePublication, /tested_id/);
  assert.match(testedImagePublication, /docker buildx imagetools inspect --raw/);
  assert.match(testedImagePublication, /\.config\.digest/);
  assert.doesNotMatch(testedImagePublication, /docker build(?:\s|$)|docker buildx build/);
});

test("release rollback cannot bypass healthy local Swarm task discovery using standalone database containers", () => {
  assert.match(smoke, /docker swarm init --advertise-addr/);
  assert.match(smoke, /docker network create --driver overlay --attachable/);
  assert.match(smoke, /docker service create --name "\$db_service_rp"/);
  assert.match(smoke, /docker service create --name "\$db_service_zitadel"/);
  assert.match(smoke, /db_container="\$\(rp_upgrade_database_task postgres-rp/);
  assert.match(smoke, /zitadel_db_container="\$\(rp_upgrade_database_task postgres-zitadel/);
  assert.doesNotMatch(smoke, /^rp_upgrade_database_task\(\)\s*\{/m);
  assert.doesNotMatch(smoke, /docker run -d --name "\$db_container"|docker run -d --name "\$zitadel_db_container"/);
  assert.match(smoke, /--health-cmd 'pg_isready/);
  assert.match(smoke, /docker service rm "\$db_service_rp" "\$db_service_zitadel"/);
  assert.match(upgrade, /com\.docker\.swarm\.service\.name=\$service/);
  assert.match(upgrade, /\.State\.Health\.Status/);
});

test("rollback Swarm convergence selects exact PostgreSQL service despite two prefix-sibling database services", () => {
  const script = [
    "source scripts/rollback-zitadel-runtime.sh",
    "docker() {",
    '  if [[ "$1 $2" == "service inspect" ]]; then',
    '    printf "%s\\n" "$3"; return 0',
    "  fi",
    '  if [[ "$1 $2" == "service ls" ]]; then',
    '    printf "%s\\n" "rp_postgres 1/1" "rp_postgres-rp 0/1" "rp_postgres-zitadel 1/1"; return 0',
    "  fi",
    "  return 1",
    "}",
    'rp_rollback_swarm_service_ready rp_postgres || exit 11',
    'if rp_rollback_swarm_service_ready rp_postgres-rp; then exit 12; fi',
    'rp_rollback_swarm_service_ready rp_postgres-zitadel || exit 13',
  ].join("\n");
  const result = spawnSync("bash", ["-euo", "pipefail", "-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const src = readFileSync("scripts/run-automatic-rollback-smoke.sh", "utf8");
  assert.match(src, /rp_rollback_swarm_service_ready "\$\{stack\}_\$\{role\}"/);
  assert.doesNotMatch(src, /docker service ls --filter "name=/);
});

test("rollback service readiness fails closed when Docker service inspect reports a different exact name", () => {
  const script = [
    "source scripts/rollback-zitadel-runtime.sh",
    'docker() { if [[ "$1 $2" == "service inspect" ]]; then printf "rp_postgres-rp\\n"; else printf "rp_postgres 1/1\\n"; fi; }',
    'if rp_rollback_swarm_service_ready rp_postgres; then exit 1; fi',
  ].join("\n");
  const result = spawnSync("bash", ["-euo", "pipefail", "-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr + result.stdout);
});


test("GHCR image publisher uses registry config digest, never local RepoDigests[0], and preserves existing tags", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, delimiter } = await import("node:path");

  const id = "sha256:" + "a".repeat(64);
  const digest = "sha256:" + "b".repeat(64);
  const otherId = "sha256:" + "c".repeat(64);
  const childDigest = "sha256:" + "d".repeat(64);
  const attestationDigest = "sha256:" + "e".repeat(64);
  const fakeDocker = String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$MOCK_LOG"
if [[ "$1" == image && "$2" == inspect ]]; then
  printf '%s\n' "$MOCK_IMAGE_ID"
  exit 0
fi
if [[ "$1" == tag ]]; then exit 0; fi
if [[ "$1" == push ]]; then
  touch "$MOCK_PUSHED"
  echo "Pushed image"
  exit 0
fi
if [[ "$1" == buildx && "$2" == imagetools && "$3" == inspect ]]; then
  if [[ "$4" == --raw ]]; then
    if [[ "$MOCK_REMOTE_CONFIG" == index ]]; then
      echo '{"mediaType":"application/vnd.oci.image.index.v1+json","schemaVersion":2,"manifests":[]}'
    elif [[ "$MOCK_REMOTE_CONFIG" == attested* ]]; then
      if [[ "$5" == *"$MOCK_CHILD_DIGEST" ]]; then
        if [[ "$MOCK_REMOTE_CONFIG" == attested_conflict ]]; then
          printf '{"mediaType":"application/vnd.oci.image.manifest.v1+json","schemaVersion":2,"config":{"digest":"%s"}}\n' "$MOCK_OTHER_ID"
        else
          printf '{"mediaType":"application/vnd.oci.image.manifest.v1+json","schemaVersion":2,"config":{"digest":"%s"}}\n' "$MOCK_IMAGE_ID"
        fi
      else
        printf '{"mediaType":"application/vnd.oci.image.index.v1+json","schemaVersion":2,"manifests":['
        printf '{"mediaType":"application/vnd.oci.image.manifest.v1+json","digest":"%s","platform":{"os":"linux","architecture":"amd64"}}' "$MOCK_CHILD_DIGEST"
        if [[ "$MOCK_REMOTE_CONFIG" == attested_multiarch ]]; then
          printf ',{"mediaType":"application/vnd.oci.image.manifest.v1+json","digest":"%s","platform":{"os":"linux","architecture":"arm64"}}' "$MOCK_ATTEST_DIGEST"
        else
          if [[ "$MOCK_REMOTE_CONFIG" == attested_badref ]]; then
            printf ',{"mediaType":"application/vnd.oci.image.manifest.v1+json","digest":"%s","platform":{"os":"unknown","architecture":"unknown"},"annotations":{"vnd.docker.reference.type":"attestation-manifest","vnd.docker.reference.digest":"%s"}}' "$MOCK_ATTEST_DIGEST" "$MOCK_ATTEST_DIGEST"
          else
            printf ',{"mediaType":"application/vnd.oci.image.manifest.v1+json","digest":"%s","platform":{"os":"unknown","architecture":"unknown"},"annotations":{"vnd.docker.reference.type":"attestation-manifest","vnd.docker.reference.digest":"%s"}}' "$MOCK_ATTEST_DIGEST" "$MOCK_CHILD_DIGEST"
          fi
        fi
        printf ']}\n'
      fi
    else
      printf '{"mediaType":"application/vnd.docker.distribution.manifest.v2+json","config":{"digest":"%s"}}\n' "$MOCK_REMOTE_CONFIG"
    fi
    exit 0
  fi
  if [[ "$MOCK_MODE" == unavailable ]]; then
    echo "unauthorized: authentication required" >&2
    exit 1
  fi
  if [[ "$MOCK_MODE" == existing || -f "$MOCK_PUSHED" ]]; then
    echo "Name: ghcr.io/re-invertion/resourceportal-api:v0.2.130"
    echo "MediaType: application/vnd.docker.distribution.manifest.v2+json"
    printf 'Digest: %s\n' "$MOCK_DIGEST"
    exit 0
  fi
  echo "ghcr.io/re-invertion/resourceportal-api:v0.2.130: not found" >&2
  exit 1
fi
echo "Unexpected fake Docker command: $*" >&2
exit 91
`;

  function run(mode, config = id) {
    const dir = mkdtempSync(join(tmpdir(), "rp-release-digest-"));
    try {
      const bin = join(dir, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "docker"), fakeDocker);
      chmodSync(join(bin, "docker"), 0o755);
      const logfile = join(dir, "commands.log");
      const pushed = join(dir, "pushed");
      const output = join(dir, "output");
      const result = spawnSync("bash", ["scripts/publish-tested-release-image.sh", "api", "v0.2.130"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: bin + delimiter + process.env.PATH,
          GITHUB_REPOSITORY_OWNER: "re-invertion",
          GITHUB_OUTPUT: output,
          MOCK_LOG: logfile,
          MOCK_PUSHED: pushed,
          MOCK_IMAGE_ID: id,
          MOCK_REMOTE_CONFIG: config,
          MOCK_CHILD_DIGEST: childDigest,
          MOCK_ATTEST_DIGEST: attestationDigest,
          MOCK_OTHER_ID: otherId,
          MOCK_DIGEST: digest,
          MOCK_MODE: mode,
        },
      });
      return {
        result,
        pushed: existsSync(pushed),
        output: existsSync(output) ? readFileSync(output, "utf8") : "",
        commands: readFileSync(logfile, "utf8"),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const fresh = run("missing");
  assert.equal(fresh.result.status, 0, fresh.result.stderr);
  assert.equal(fresh.pushed, true);
  assert.equal(fresh.output, "digest=" + digest + "\n");
  assert.match(fresh.commands, /buildx imagetools inspect --raw ghcr.io\/re-invertion\/resourceportal-api@sha256:/);

  const reused = run("existing");
  assert.equal(reused.result.status, 0, reused.result.stderr);
  assert.equal(reused.pushed, false, "already-published identical image must never be pushed again");
  assert.equal(reused.output, "digest=" + digest + "\n");

  const conflict = run("existing", otherId);
  assert.notEqual(conflict.result.status, 0);
  assert.equal(conflict.pushed, false, "must not overwrite a conflicting existing registry tag");
  assert.match(conflict.result.stderr, /differs from rollback-tested image/);

  const unavailable = run("unavailable");
  assert.notEqual(unavailable.result.status, 0);
  assert.equal(unavailable.pushed, false, "registry/auth errors must never allow a push");
  assert.match(unavailable.result.stderr, /Cannot determine whether/);

  const corrupted = run("missing", otherId);
  assert.notEqual(corrupted.result.status, 0);
  assert.equal(corrupted.pushed, true);
  assert.match(corrupted.result.stderr, /differs from rollback-tested image/);
  assert.equal(corrupted.output, "", "must not emit a digest when verification fails");

  const attestedFresh = run("missing", "attested");
  assert.equal(attestedFresh.result.status, 0, attestedFresh.result.stderr);
  assert.equal(attestedFresh.pushed, true);
  assert.equal(attestedFresh.output, "digest=" + digest + "\n", "preserve outer OCI index digest");
  assert.match(attestedFresh.commands, new RegExp("imagetools inspect --raw ghcr.io/re-invertion/resourceportal-api@" + childDigest));

  const attestedExisting = run("existing", "attested");
  assert.equal(attestedExisting.result.status, 0, attestedExisting.result.stderr);
  assert.equal(attestedExisting.pushed, false);
  assert.equal(attestedExisting.output, "digest=" + digest + "\n");

  for (const indexMode of ["index", "attested_multiarch", "attested_badref"]) {
    const invalid = run("existing", indexMode);
    assert.notEqual(invalid.result.status, 0, indexMode + ": invalid OCI index should fail closed");
    assert.equal(invalid.pushed, false, "invalid OCI index must not cause overwrite");
    assert.match(invalid.result.stderr, /ambiguous runnable images or invalid attestations/);
  }

  const mismatchedChild = run("existing", "attested_conflict");
  assert.notEqual(mismatchedChild.result.status, 0);
  assert.equal(mismatchedChild.pushed, false);
  assert.match(mismatchedChild.result.stderr, /differs from rollback-tested image/);
});


test("partially published OCI release recovery audit proves immutable images and fails closed", async () => {
  const { createHash } = await import("node:crypto");
  const { auditInterruptedRelease } = await import("../scripts/audit-v02129-release-recovery.mjs");
  const digest = (data) => "sha256:" + createHash("sha256").update(data).digest("hex");
  const serialize = (value) => JSON.stringify(value);
  const configDigest = "sha256:" + "a".repeat(64);
  const attestationRaw = serialize({ schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { digest: "sha256:" + "b".repeat(64) },
  });
  const attestationDigest = digest(attestationRaw);
  const runnableRaw = serialize({
    schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { digest: configDigest },
  });
  const runnableDigest = digest(runnableRaw);
  const indexRaw = serialize({
    schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: runnableDigest,
        platform: { os: "linux", architecture: "amd64" } },
      { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: attestationDigest,
        platform: { os: "unknown", architecture: "unknown" },
        annotations: { "vnd.docker.reference.type": "attestation-manifest",
          "vnd.docker.reference.digest": runnableDigest } },
    ],
  });
  const indexDigest = digest(indexRaw);
  const expected = {
    sourceSha: "a".repeat(40), previousTag: "v0.2.128", version: "v0.2.129",
    apiIndex: indexDigest, apiManifest: runnableDigest, attestation: attestationDigest,
    apiConfig: configDigest,
  };
  const json = (body, status = 200, headers = {}) =>
    new Response(JSON.stringify(body), { status, headers });
  const raw = (body, d) =>
    new Response(body, { status: 200, headers: { "docker-content-digest": d } });
  const routes = new Map([
    ["https://api.github.com/repos/re-invertion/resourcePortal/branches/main",
      json({ commit: { sha: expected.sourceSha } })],
    ["https://api.github.com/repos/re-invertion/resourcePortal/releases/latest",
      json({ tag_name: expected.previousTag })],
    ["https://api.github.com/repos/re-invertion/resourcePortal/releases/tags/v0.2.129",
      new Response(null, { status: 404 })],
    ["https://ghcr.io/token?scope=repository:re-invertion/resourceportal-api:pull&service=ghcr.io",
      json({ token: "test-readonly-token" })],
    ["https://ghcr.io/v2/re-invertion/resourceportal-api/manifests/v0.2.129",
      raw(indexRaw, indexDigest)],
    ["https://ghcr.io/v2/re-invertion/resourceportal-api/manifests/" + indexDigest,
      raw(indexRaw, indexDigest)],
    ["https://ghcr.io/v2/re-invertion/resourceportal-api/manifests/" + runnableDigest,
      raw(runnableRaw, runnableDigest)],
    ["https://ghcr.io/v2/re-invertion/resourceportal-api/manifests/" + attestationDigest,
      raw(attestationRaw, attestationDigest)],
    ["https://ghcr.io/token?scope=repository:re-invertion/resourceportal-web:pull&service=ghcr.io",
      json({ token: "test-readonly-token" })],
    ["https://ghcr.io/token?scope=repository:re-invertion/resourceportal-postgres:pull&service=ghcr.io",
      json({ token: "test-readonly-token" })],
    ["https://ghcr.io/v2/re-invertion/resourceportal-web/manifests/v0.2.129",
      new Response(null, { status: 404 })],
    ["https://ghcr.io/v2/re-invertion/resourceportal-postgres/manifests/v0.2.129",
      new Response(null, { status: 404 })],
  ]);
  function mockFetch(overrides = {}) {
    const calls = [];
    const fetchImpl = async (url, options) => {
      assert.equal(options?.method ?? "GET", "GET", "audit may only make reads");
      calls.push(url);
      const response = overrides[url] || routes.get(url);
      assert.ok(response, "unexpected recovery URL " + url);
      return response.clone();
    };
    return { fetchImpl, calls };
  }
  const success = mockFetch();
  const result = await auditInterruptedRelease(success.fetchImpl, expected);
  assert.equal(result.github.mainSha, expected.sourceSha);
  assert.equal(result.api.indexDigest, indexDigest);
  assert.equal(result.api.configDigest, configDigest);
  assert.equal(result.canPublishFromThisAudit, false);
  assert.deepEqual(result.otherImages, { web: "absent", postgres: "absent" });
  assert.equal(success.calls.length, routes.size);
  assert(!success.calls.some((url) => url.includes("upload") || url.includes("tags/create")));

  const mainUrl = "https://api.github.com/repos/re-invertion/resourcePortal/branches/main";
  await assert.rejects(
    auditInterruptedRelease(mockFetch({ [mainUrl]: json({commit:{sha:"f".repeat(40)}}) }).fetchImpl, expected),
    /main drifted/);

  const indexUrl = "https://ghcr.io/v2/re-invertion/resourceportal-api/manifests/v0.2.129";
  await assert.rejects(
    auditInterruptedRelease(mockFetch({ [indexUrl]: raw(indexRaw, "sha256:" + "f".repeat(64)) }).fetchImpl, expected),
    /registry response bytes do not hash/);
  await assert.rejects(
    auditInterruptedRelease(mockFetch({ [indexUrl]: raw(indexRaw + " ", indexDigest) }).fetchImpl, expected),
    /registry response bytes do not hash/);

  await assert.rejects(
    auditInterruptedRelease(mockFetch().fetchImpl, { ...expected, apiConfig:"sha256:"+"c".repeat(64) }),
    /rollback-tested API config digest differs/);

  const webUrl = "https://ghcr.io/v2/re-invertion/resourceportal-web/manifests/v0.2.129";
  await assert.rejects(
    auditInterruptedRelease(mockFetch({ [webUrl]: json({mediaType:"application/vnd.oci.image.index.v1+json"}) }).fetchImpl, expected),
    /unexpected pre-existing web image/);

  const releaseUrl = "https://api.github.com/repos/re-invertion/resourcePortal/releases/tags/v0.2.129";
  await assert.rejects(
    auditInterruptedRelease(mockFetch({ [releaseUrl]: json({tag_name:"v0.2.129"}) }).fetchImpl, expected),
    /already published/);

  // The old GitHub release job was re-run with the SAME SHA and repushed a
  // different attested OCI index under the orphaned v0.2.129 tag. Accept
  // exactly the two pinned attempts as evidence, never an unknown rewrite.
  const rerunConfig = "sha256:" + "c".repeat(64);
  const rerunAttestationRaw = serialize({
    schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { digest: "sha256:" + "d".repeat(64) },
  });
  const rerunAttestation = digest(rerunAttestationRaw);
  const rerunImageRaw = serialize({
    schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { digest: rerunConfig },
  });
  const rerunManifest = digest(rerunImageRaw);
  const rerunIndexRaw = serialize({
    schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: rerunManifest,
        platform: { os: "linux", architecture: "amd64" } },
      { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: rerunAttestation,
        platform: { os: "unknown", architecture: "unknown" },
        annotations: { "vnd.docker.reference.type": "attestation-manifest",
          "vnd.docker.reference.digest": rerunManifest } },
    ],
  });
  const rerunIndex = digest(rerunIndexRaw);
  const rerunExpected = { ...expected, rerun: {
    apiIndex: rerunIndex, apiManifest: rerunManifest,
    attestation: rerunAttestation, apiConfig: rerunConfig,
  } };
  const rerunOverrides = {
    [indexUrl]: raw(rerunIndexRaw, rerunIndex),
    ["https://ghcr.io/v2/re-invertion/resourceportal-api/manifests/" + rerunIndex]:
      raw(rerunIndexRaw, rerunIndex),
    ["https://ghcr.io/v2/re-invertion/resourceportal-api/manifests/" + rerunManifest]:
      raw(rerunImageRaw, rerunManifest),
    ["https://ghcr.io/v2/re-invertion/resourceportal-api/manifests/" + rerunAttestation]:
      raw(rerunAttestationRaw, rerunAttestation),
  };
  const verifiedRerun = await auditInterruptedRelease(mockFetch(rerunOverrides).fetchImpl, rerunExpected);
  assert.equal(verifiedRerun.api.orphanTagRewrittenByFailedRerun, true);
  assert.equal(verifiedRerun.api.observedOrphanTagDigest, rerunIndex);
  assert.equal(verifiedRerun.api.indexDigest, indexDigest,
    "original index remains the immutable release proof");
  assert.equal(verifiedRerun.canPublishFromThisAudit, false);

  await assert.rejects(
    auditInterruptedRelease(mockFetch(rerunOverrides).fetchImpl, expected),
    /registry digest mismatch/);
  const unknownIndex = "sha256:" + "f".repeat(64);
  await assert.rejects(
    auditInterruptedRelease(mockFetch({ [indexUrl]: raw(rerunIndexRaw, unknownIndex) }).fetchImpl, rerunExpected),
    /registry response bytes do not hash/);
  await assert.rejects(
    auditInterruptedRelease(mockFetch({
      ...rerunOverrides,
      ["https://ghcr.io/v2/re-invertion/resourceportal-api/manifests/" + rerunManifest]:
        raw(rerunImageRaw, unknownIndex),
    }).fetchImpl, rerunExpected),
    /registry digest mismatch/);

  const originalTagOverrides = { ...rerunOverrides, [indexUrl]: raw(indexRaw, indexDigest) };
  const bothVerifiedWithOriginalTag = await auditInterruptedRelease(
    mockFetch(originalTagOverrides).fetchImpl, rerunExpected);
  assert.equal(bothVerifiedWithOriginalTag.api.orphanTagRewrittenByFailedRerun, false);
  assert.equal(bothVerifiedWithOriginalTag.api.observedOrphanTagDigest, indexDigest);

  const unavailableRerunEvidence = {
    ...originalTagOverrides,
    ["https://ghcr.io/v2/re-invertion/resourceportal-api/manifests/" + rerunManifest]:
      new Response(null, { status: 404 }),
  };
  await assert.rejects(
    auditInterruptedRelease(mockFetch(unavailableRerunEvidence).fetchImpl, rerunExpected),
    /Unexpected HTTP 404/,
    "missing attempt-2 evidence must block even when mutable tag points to attempt 1");
});
