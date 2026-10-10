#!/usr/bin/env node
// Conservatively classify rollback compatibility for a *specific* release range.
// This is not a SQL migration reversibility detector. A migration-changing
// release requires explicit, independently executed compatibility/restore tests.
import { execFileSync } from "node:child_process";

const DATA_PATHS = [
  "packages/resourceportal-api/prisma/migrations",
  "packages/resourceportal-api/prisma/schema.prisma",
  "packages/resourceportal-api/prisma/migrations_lock.toml",
];

export function rollbackAssessment(changedPaths, mode, previousVersion, targetCommit) {
  const changes = changedPaths.filter(Boolean);
  const schemaChanges = changes.filter((path) =>
    DATA_PATHS.some((prefix) => path === prefix || path.startsWith(prefix + "/")),
  );
  const imageOnly = mode === "fastfix" && schemaChanges.length === 0;
  return {
    policy: imageOnly ? "image-only" : "none",
    reason: imageOnly
      ? "no-resourceportal-database-schema-changes"
      : schemaChanges.length
        ? "database-compatibility-not-verified"
        : "milestone-requires-verified-recovery",
    sourceVersion: previousVersion.replace(/^v/, ""),
    targetCommit,
  };
}

function option(flag) {
  const i = process.argv.indexOf(flag);
  return i < 0 ? null : process.argv[i + 1];
}

if (process.argv[1]?.endsWith("/release-rollback-policy.mjs")) {
  const previous = option("--previous-tag");
  const head = option("--head");
  const mode = option("--mode");
  if (!previous || !head || !["fastfix", "milestone"].includes(mode)) {
    throw new Error("--previous-tag, --head and --mode are required");
  }
  // Fail closed on any Git error, unknown history, or missing comparison tag.
  const paths = execFileSync("git", [
    "diff", "--name-only", previous + "...", head, "--",
  ], { encoding: "utf8" }).split("\n").filter(Boolean);
  const commit = execFileSync("git", ["rev-parse", head + "^{commit}"], {
    encoding: "utf8",
  }).trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Invalid target commit");
  const result = rollbackAssessment(paths, mode, previous, commit);
  console.log(JSON.stringify(result));
  const output = option("--github-output");
  if (output) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(output, [
      "rollback_policy=" + result.policy,
      "rollback_reason=" + result.reason,
      "rollback_source_version=" + result.sourceVersion,
      "rollback_target_commit=" + result.targetCommit,
      "",
    ].join("\n"));
  }
}
