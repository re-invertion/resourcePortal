import test from "node:test";
import assert from "node:assert/strict";
import { rollbackAssessment } from "../scripts/release-rollback-policy.mjs";

const hash = "a".repeat(40);
test("non-schema patch permits only image-only rollback", () => {
  assert.deepEqual(rollbackAssessment(["packages/resourceportal-web/src/app.tsx"], "fastfix", "v0.2.75", hash), {
    policy: "image-only",
    reason: "no-resourceportal-database-schema-changes",
    sourceVersion: "0.2.75",
    targetCommit: hash,
  });
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
    mkdirSync(join(work, "packages/resourceportal-api/prisma/migrations"), { recursive: true });
    writeFileSync(join(work, "packages/resourceportal-api/prisma/migrations/new.sql"), "ALTER TABLE demo ADD COLUMN a INT;\n");
    command(["add", "."]);
    command(["commit", "-q", "-m", "schema change"]);
    const second = spawnSync(process.execPath, args, { cwd: work, encoding: "utf8" });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).policy, "none");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
