import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
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

// A real isolated Git repository catches incorrect argument construction that
// pure rollbackAssessment tests cannot detect.
test("CLI computes rollback policy from real Git ancestry and fails closed", () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = fs;
  const { tmpdir } = os;
  const root = mkdtempSync(join(tmpdir(), "rp-release-rollback-"));
  try {
    const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.name", "CI Test");
    git("config", "user.email", "ci@example.test");
    writeFileSync(join(root, "file.txt"), "base\n");
    git("add", "file.txt");
    git("commit", "-qm", "base");
    git("tag", "v0.2.75");
    writeFileSync(join(root, "file.txt"), "patch\n");
    git("commit", "-qam", "patch");
    const args = [fileURLToPath(new URL("../scripts/release-rollback-policy.mjs", import.meta.url)),
      "--previous-tag", "v0.2.75", "--head", "HEAD", "--mode", "fastfix"];
    const run = () => JSON.parse(execFileSync(process.execPath, args, {
      cwd: root, encoding: "utf8",
    }));
    assert.equal(run().policy, "image-only");

    const migration = join(root, "packages/resourceportal-api/prisma/migrations/test_1");
    mkdirSync(migration, { recursive: true });
    writeFileSync(join(migration, "migration.sql"), "ALTER TABLE demo ADD COLUMN new_flag BOOLEAN;\n");
    git("add", ".");
    git("commit", "-qm", "schema change");
    assert.deepEqual({ policy: run().policy, reason: run().reason },
      { policy: "none", reason: "database-compatibility-not-verified" });
    assert.throws(() => execFileSync(process.execPath,
      args.map(a => a === "v0.2.75" ? "v9.9.9" : a),
      { cwd: root, stdio: "pipe" }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
