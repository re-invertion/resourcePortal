import test from "node:test";
import assert from "node:assert/strict";
import { rollbackAssessment, requireAutomaticRollback, assertExpandOnlyMigrationSql } from "../scripts/release-rollback-policy.mjs";

const hash = "a".repeat(40);
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

test("schema-changing rollback requires exact run-bound live evidence", () => {
  const result = rollbackAssessment(
    ["packages/resourceportal-api/prisma/migrations/20261012_new/migration.sql"],
    "fastfix", "v0.2.86", hash,
  );
  const currentRunId = Number(process.env.GITHUB_RUN_ID || 12345);
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
  };
  assert.throws(() => requireAutomaticRollback(result), /Release blocked/);
  const confirmed = requireAutomaticRollback(result, evidence);
  assert.equal(confirmed.policy, "tested");
  assert.equal(confirmed.reason, "verified-recovery-test");
  assert.deepEqual(confirmed.rollbackEvidence, {
    kind: "real-upgrade-and-restore", workflowRunId: currentRunId, sourceVersion: "0.2.86",
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
  ]) assert.throws(() => requireAutomaticRollback(result, malformed), /Release blocked/);
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
