import test from "node:test";
import assert from "node:assert/strict";
import { rollbackAssessment, requireAutomaticRollback, assertExpandOnlyMigrationSql } from "../scripts/release-rollback-policy.mjs";

const hash = "a".repeat(40);
const candidateZitadelImage = "ghcr.io/zitadel/zitadel@sha256:" + "a".repeat(64);
const sourceZitadelImage = "ghcr.io/zitadel/zitadel@sha256:" + "b".repeat(64);
test("non-schema patch permits only image-only rollback", () => {
  assert.deepEqual(rollbackAssessment(["packages/resourceportal-web/src/app.tsx"], "fastfix", "v0.2.75", hash), {
    policy: "image-only",
    reason: "no-resourceportal-database-schema-changes",
    sourceVersion: "0.2.75",
    targetCommit: hash,
  });
});
test("release is blocked when automatic rollback is not eligible", () => {
  const allowed = rollbackAssessment(["docs/release-validation-policy.md"], "fastfix", "v0.2.85", hash);
  assert.equal(requireAutomaticRollback(allowed).policy, "image-only");
  for (const invalid of [
    rollbackAssessment(["packages/resourceportal-api/prisma/migrations/new/migration.sql"], "fastfix", "v0.2.85", hash),
    rollbackAssessment([], "milestone", "v0.2.85", hash),
    { ...allowed, policy: "tested", reason: "verified-recovery-test" },
    { ...allowed, sourceVersion: "*" },
    { ...allowed, targetCommit: "invalid" },
  ]) assert.throws(() => requireAutomaticRollback(invalid), /Release blocked/);
});

test("NVIDIA GPU migration qualifies as expand-only SQL, but never skips live rollback certification", async () => {
  const { readFileSync } = await import("node:fs");
  const sql = readFileSync(
    new URL("../packages/resourceportal-api/prisma/migrations/20261027231000_nvidia_gpu_exclusive_allocation/migration.sql", import.meta.url),
    "utf8",
  );
  assert.doesNotThrow(() => assertExpandOnlyMigrationSql(sql));
  const candidate = rollbackAssessment(
    ["packages/resourceportal-api/prisma/migrations/20261027231000_nvidia_gpu_exclusive_allocation/migration.sql"],
    "fastfix", "v0.2.110", hash,
  );
  assert.equal(candidate.policy, "none");
  assert.equal(candidate.reason, "database-compatibility-not-verified");
  assert.throws(() => requireAutomaticRollback(candidate), /Release blocked/);
});

test("only immutable expand-only database migrations can qualify for tested rollback", () => {
  assert.doesNotThrow(() => assertExpandOnlyMigrationSql(`
    -- New isolated IDP provider and optional legacy-client linkage
    CREATE TABLE "TenantOidcProvider" ("tenantId" UUID NOT NULL);
    ALTER TABLE "OAuthApplication" ADD COLUMN "zitadelProjectId" TEXT;
    CREATE UNIQUE INDEX "TenantOidcProvider_id_idx" ON "TenantOidcProvider"("tenantId");
    ALTER TABLE "TenantOidcProvider" ADD CONSTRAINT "tenant_fk"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id");
  `));
  for (const bad of [
    'ALTER TABLE "User" DROP COLUMN "email";',
    'DROP TABLE "User";',
    'DELETE FROM "OAuthApplication";',
    'ALTER TABLE "User" ADD COLUMN "password" TEXT NOT NULL;',
    'CREATE UNIQUE INDEX "User_email_key_new" ON "User"("email");',
    'ALTER TABLE "User" ADD CONSTRAINT "fk" FOREIGN KEY ("id") REFERENCES "Tenant"("id");',
    '-- only comments',
  ]) assert.throws(() => assertExpandOnlyMigrationSql(bad), /Release blocked|Empty migration/);
});

test("Gate additive NOT NULL constant defaults pass only with real rollback evidence", async () => {
  const { readFileSync } = await import("node:fs");
  const sql = readFileSync(
    new URL("../packages/resourceportal-api/prisma/migrations/20261018000100_generic_application_lan_policy/migration.sql", import.meta.url),
    "utf8",
  );
  assert.doesNotThrow(() => assertExpandOnlyMigrationSql(sql));
  assert.doesNotThrow(() => assertExpandOnlyMigrationSql(`
    ALTER TABLE "ResourcePortalGate"
      ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'Legacy',
      ADD COLUMN "policies" JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
  `));
  for (const unsafe of [
    'ALTER TABLE "User" ADD COLUMN "token" TEXT NOT NULL;',
    'ALTER TABLE "User" ADD COLUMN "token" TEXT NOT NULL DEFAULT now();',
    'ALTER TABLE "User" ADD COLUMN "token" TEXT NOT NULL DEFAULT (SELECT secret FROM "User");',
    'ALTER TABLE "User" ADD COLUMN "token" TEXT NOT NULL DEFAULT current_user;',
    'ALTER TABLE "User" ADD COLUMN "token" TEXT NOT NULL DEFAULT NULL;',
    'ALTER TABLE "User" ADD COLUMN "token" BOOLEAN NOT NULL DEFAULT true;',
    "ALTER TABLE \"User\" ADD COLUMN \"token\" TEXT NOT NULL DEFAULT 'ok', DROP COLUMN \"email\";",
    "ALTER TABLE \"User\" ADD COLUMN \"token\" TEXT NOT NULL DEFAULT 'ok', ALTER COLUMN \"email\" DROP NOT NULL;",
    "ALTER TABLE \"User\" ALTER COLUMN \"token\" SET DEFAULT 'ok';",
    "ALTER TABLE \"User\" ADD COLUMN \"token\" TEXT NOT NULL DEFAULT 'ok' REFERENCES \"Tenant\"(\"id\");",
  ]) assert.throws(() => assertExpandOnlyMigrationSql(unsafe), /Release blocked/);
});

test("schema-changing rollback requires exact run-bound live evidence", () => {
  const result = rollbackAssessment(
    ["packages/resourceportal-api/prisma/migrations/20261012_new/migration.sql"],
    "fastfix", "v0.2.86", hash,
  );
  const currentRunId = Number(process.env.GITHUB_RUN_ID || 12345);
  const previousRunId = process.env.GITHUB_RUN_ID;
  // Simulate the real GitHub Actions environment: evidence must belong to
  // THIS workflow run, not merely carry a positive numeric run identifier.
  process.env.GITHUB_RUN_ID = String(currentRunId);
  const evidence = {
    kind: "real-upgrade-and-restore",
    sourceVersion: "0.2.86",
    targetCommit: hash,
    workflowRunId: currentRunId,
    actualDatabaseMigration: true,
    previousApiReadWriteAfterRollback: true,
    previousApiRuntimeReadyAfterRollback: true,
    injectedHealthFailure: true,
    previousImagesRestored: true,
    databaseSnapshotVerified: true,
    databaseSnapshotRestored: true,
    restoredSourceSchema: true,
    zitadelDatabaseRestored: true,
    zitadelSourceRuntimeReadyAfterRollback: true,
    zitadelSourceEventstoreVerified: true,
    candidateZitadelRuntimeReadyBeforeRollback: true,
    candidateZitadelImage,
    sourceZitadelImage,
  };
  assert.throws(() => requireAutomaticRollback(result), /Release blocked/);
  const confirmed = requireAutomaticRollback(result, evidence);
  assert.equal(confirmed.policy, "tested");
  assert.equal(confirmed.reason, "verified-recovery-test");
  assert.deepEqual(confirmed.rollbackEvidence, {
    kind: "real-upgrade-and-restore", workflowRunId: currentRunId, sourceVersion: "0.2.86",
    databaseSnapshotRestored: true, restoredSourceSchema: true, zitadelDatabaseRestored: true,
    zitadelSourceRuntimeReadyAfterRollback: true,
    zitadelSourceEventstoreVerified: true,
    candidateZitadelRuntimeReadyBeforeRollback: true,
    candidateZitadelImage,
    sourceZitadelImage,
  });
  for (const malformed of [
    { ...evidence, targetCommit: "b".repeat(40) },
    { ...evidence, sourceVersion: "0.2.85" },
    { ...evidence, workflowRunId: 0 },
    { ...evidence, workflowRunId: currentRunId + 1 },
    { ...evidence, workflowRunId: "12345" },
    { ...evidence, previousApiReadWriteAfterRollback: false },
    { ...evidence, previousApiRuntimeReadyAfterRollback: false },
    { ...evidence, previousImagesRestored: false },
    { ...evidence, actualDatabaseMigration: false },
    { ...evidence, injectedHealthFailure: false },
    { ...evidence, kind: "static-schema-heuristic" },
    { ...evidence, databaseSnapshotVerified: false },
    { ...evidence, databaseSnapshotRestored: false },
    { ...evidence, restoredSourceSchema: false },
    { ...evidence, zitadelDatabaseRestored: false },
    { ...evidence, zitadelSourceRuntimeReadyAfterRollback: false },
    { ...evidence, zitadelSourceEventstoreVerified: false },
    { ...evidence, candidateZitadelRuntimeReadyBeforeRollback: false },
    { ...evidence, zitadelSourceRuntimeReadyAfterRollback: "true" },
    { ...evidence, zitadelSourceEventstoreVerified: 1 },
    { ...evidence, candidateZitadelRuntimeReadyBeforeRollback: null },
    { ...evidence, candidateZitadelImage: "ghcr.io/zitadel/zitadel:v4.17.0" },
    { ...evidence, candidateZitadelImage: undefined },
    { ...evidence, sourceZitadelImage: "ghcr.io/malicious/zitadel@sha256:" + "f".repeat(64) },
  ]) assert.throws(() => requireAutomaticRollback(result, malformed), /Release blocked/);
  if (previousRunId === undefined) delete process.env.GITHUB_RUN_ID;
  else process.env.GITHUB_RUN_ID = previousRunId;
});

test("milestone releases never bypass live rollback certification", () => {
  const result = rollbackAssessment([], "milestone", "v0.2.86", hash);
  assert.throws(() => requireAutomaticRollback(result), /Release blocked/);
  const certified = requireAutomaticRollback(result, {
    kind: "real-upgrade-and-restore", sourceVersion: "0.2.86", targetCommit: hash,
    workflowRunId: Number(process.env.GITHUB_RUN_ID || 12345), actualDatabaseMigration: true,
    previousApiReadWriteAfterRollback: true,
    previousApiRuntimeReadyAfterRollback: true, injectedHealthFailure: true,
    previousImagesRestored: true,
    databaseSnapshotVerified: true, databaseSnapshotRestored: true,
    restoredSourceSchema: true, zitadelDatabaseRestored: true,
    zitadelSourceRuntimeReadyAfterRollback: true,
    zitadelSourceEventstoreVerified: true,
    candidateZitadelRuntimeReadyBeforeRollback: true,
    candidateZitadelImage,
    sourceZitadelImage,
  });
  assert.equal(certified.policy, "tested");
});

test("SQL or Prisma schema edits can never claim tested without a real compatibility gate", () => {
  for (const path of [
    "packages/resourceportal-api/prisma/migrations/20261010_demo/migration.sql",
    "packages/resourceportal-api/prisma/schema.prisma",
  ]) {
    const result = rollbackAssessment([path], "fastfix", "v0.2.75", hash);
    assert.equal(result.policy, "none");
    assert.equal(result.reason, "database-compatibility-not-verified");
  }
});
test("milestones fail closed, including an empty diff", () => {
  assert.equal(rollbackAssessment([], "milestone", "v0.2.75", hash).policy, "none");
});


test("destructive LAN retirement DDL requires exact-run restored-source proof and new migration history", async () => {
  const { execFileSync, spawnSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const work = mkdtempSync(join(tmpdir(), "rp-milestone-retirement-"));
  const command = args => execFileSync("git", ["-C", work, ...args], {encoding:"utf8"}).trim();
  const runner = resolve("scripts/release-rollback-policy.mjs");
  const runId = 89987;
  const env = {...process.env, GITHUB_ACTIONS:"false", GITHUB_RUN_ID:String(runId)};
  try {
    command(["init","-q"]);
    command(["config","user.email","test@example.invalid"]);
    command(["config","user.name","RP Test"]);
    const base="packages/resourceportal-api/prisma/migrations";
    mkdirSync(join(work,base,"20261001000000_baseline"),{recursive:true});
    writeFileSync(join(work,base,"20261001000000_baseline","migration.sql"),
      'CREATE TABLE "Tenant" ("id" TEXT);\n');
    command(["add","."]);
    command(["commit","-q","-m","source schema"]);
    command(["tag","v0.2.95"]);
    mkdirSync(join(work,base,"20261023000000_lan_retirement"));
    writeFileSync(join(work,base,"20261023000000_lan_retirement","migration.sql"),
      'DROP TABLE "GateNetworkAttachment";\nALTER TABLE "ResourcePortalGate" DROP COLUMN "allowLanToRp";\n');
    command(["add","."]);
    command(["commit","-q","-m","retire old routing with verified restore"]);
    const commit=command(["rev-parse","HEAD"]);
    const argv=[runner,"--previous-tag","v0.2.95","--head","HEAD",
      "--mode","milestone","--require-automatic"];
    const run=args=>spawnSync(process.execPath,args,{cwd:work,env,encoding:"utf8"});
    const absent=run(argv);
    assert.notEqual(absent.status,0,"destructive migration must not ship without independent evidence");
    assert.match(absent.stderr,/Release blocked/);
    const evidence={
      kind:"real-upgrade-and-restore",sourceVersion:"0.2.95",targetCommit:commit,
      workflowRunId:runId,actualDatabaseMigration:true,previousApiReadWriteAfterRollback:true,
      previousApiRuntimeReadyAfterRollback:true,injectedHealthFailure:true,
      previousImagesRestored:true,databaseSnapshotVerified:true,databaseSnapshotRestored:true,
      restoredSourceSchema:true,zitadelDatabaseRestored:true,zitadelSourceRuntimeReadyAfterRollback:true,
      zitadelSourceEventstoreVerified:true,candidateZitadelRuntimeReadyBeforeRollback:true,
      candidateZitadelImage:"ghcr.io/zitadel/zitadel@sha256:"+"a".repeat(64),
      sourceZitadelImage:"ghcr.io/zitadel/zitadel@sha256:"+"b".repeat(64),
    };
    const evidencePath=join(work,"source-restore-test-fixture.json");
    writeFileSync(evidencePath,JSON.stringify(evidence));
    const validated=run([...argv,"--verified-evidence-file",evidencePath]);
    assert.equal(validated.status,0,validated.stderr);
    assert.equal(JSON.parse(validated.stdout).policy,"tested");
    writeFileSync(evidencePath,JSON.stringify({...evidence,databaseSnapshotRestored:false}));
    const denied=run([...argv,"--verified-evidence-file",evidencePath]);
    assert.notEqual(denied.status,0,"missing database restore evidence must fail closed");
    // Published history may NOT be rewritten even when a later DB restore is certified.
    writeFileSync(join(work,base,"20261001000000_baseline","migration.sql"),
      'DROP TABLE "Tenant";\n');
    command(["add","."]);command(["commit","-q","-m","alter published migration"]);
    const changedCommit=command(["rev-parse","HEAD"]);
    writeFileSync(evidencePath,JSON.stringify({...evidence,targetCommit:changedCommit}));
    const tampered=run([...argv,"--verified-evidence-file",evidencePath]);
    assert.notEqual(tampered.status,0);
    assert.match(tampered.stderr,/immutable/);
  } finally {
    rmSync(work,{recursive:true,force:true});
  }
});

test("release CLI compares both tag and target commit in a real Git history", async () => {
  const { execFileSync, spawnSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const work = mkdtempSync(join(tmpdir(), "rp-release-diff-"));
  const command = (args) => execFileSync("git", ["-C", work, ...args], { encoding: "utf8" });
  try {
    command(["init", "-q"]);
    command(["config", "user.email", "test@example.invalid"]);
    command(["config", "user.name", "RP Test"]);
    writeFileSync(join(work, "README.md"), "old\n");
    command(["add", "README.md"]);
    command(["commit", "-q", "-m", "old release"]);
    command(["tag", "v0.2.75"]);
    writeFileSync(join(work, "README.md"), "new\n");
    command(["commit", "-q", "-am", "patch"]);
    const runner = resolve("scripts/release-rollback-policy.mjs");
    const args = [runner, "--previous-tag", "v0.2.75", "--head", "HEAD", "--mode", "fastfix"];
    const first = spawnSync(process.execPath, args, { cwd: work, encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).policy, "image-only");
    const safe = spawnSync(process.execPath, [...args, "--require-automatic"], { cwd: work, encoding: "utf8" });
    assert.equal(safe.status, 0, safe.stderr);
    mkdirSync(join(work, "packages/resourceportal-api/prisma/migrations"), { recursive: true });
    writeFileSync(join(work, "packages/resourceportal-api/prisma/migrations/new.sql"), "ALTER TABLE demo ADD COLUMN a INT;\n");
    command(["add", "."]);
    command(["commit", "-q", "-m", "schema change"]);
    const second = spawnSync(process.execPath, args, { cwd: work, encoding: "utf8" });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).policy, "none");
    const unsafe = spawnSync(process.execPath, [...args, "--require-automatic"], { cwd: work, encoding: "utf8" });
    assert.notEqual(unsafe.status, 0);
    assert.match(unsafe.stderr, /Release blocked/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});