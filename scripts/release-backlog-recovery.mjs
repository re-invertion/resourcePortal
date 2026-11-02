#!/usr/bin/env node
// One-time, fail-closed recovery from the unpublished 0ae0827 main revision.
// No registry writes, tag creation, shortcut to release or bypass of rollback.
// The reviewed PR #382 must be the *only* delta from the blocked main commit.
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const BACKLOG = Object.freeze({
  publishedTag: "v0.2.128",
  publishedSha: "34bbb1a0b918fb46b71c988fe79c22ee6bf7cca0",
  blockedMainSha: "0ae0827bfc2a0971a4ffd37becbe0e61438b32e7",
  partiallyPushedTag: "v0.2.129",
  targetTag: "v0.2.130",
  // Content of the rollback-tested image publisher and registry audit was
  // reviewed and tested independently before this recovery exception.
  immutableBlobs: Object.freeze({
    "scripts/publish-tested-release-image.sh": "db77813fb3411e086820b479a003364af1e92290",
    "scripts/audit-v02129-release-recovery.mjs": "95060eb5ce3683129f07ce174b109935eb20d4bd",
  }),
  allowedPaths: Object.freeze([
    ".github/workflows/release-readiness.yml",
    "docs/automatic-main-releases.md",
    "scripts/audit-v02129-release-recovery.mjs",
    "scripts/fastfix-test-plan.mjs",
    "scripts/next-main-release.mjs",
    "scripts/publish-tested-release-image.sh",
    "scripts/release-backlog-recovery.mjs",
    "test/fastfix-test-plan.test.mjs",
    "test/next-main-release.test.mjs",
    "test/test-upgrade-database-rollback.test.mjs",
    "test/test-workflow-gates.test.mjs",
  ]),
});

function check(condition, detail) {
  if (!condition) throw new Error("One-time recovery denied: " + detail);
}

export function verifyBacklogCandidate({
  publishedTag, publishedSha, changedPaths, blobs, sourceIsAncestor,
  versionTags = [],
}) {
  check(publishedTag === BACKLOG.publishedTag, "wrong published source tag");
  check(publishedSha === BACKLOG.publishedSha, "wrong published source SHA");
  check(sourceIsAncestor, "blocked main SHA is not an ancestor of candidate");
  const actualPaths = [...changedPaths].sort();
  const expectedPaths = [...BACKLOG.allowedPaths].sort();
  check(JSON.stringify(actualPaths) === JSON.stringify(expectedPaths),
    "candidate file set differs from exact reviewed PR #382");
  for (const [path, sha] of Object.entries(BACKLOG.immutableBlobs)) {
    check(blobs[path] === sha, "reviewed file content differs: " + path);
  }
  check(!versionTags.includes(BACKLOG.targetTag),
    "v0.2.130 already has a Git tag; never reuse it");
  return BACKLOG.targetTag;
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

export function verifyBacklogCheckout(publishedTag, publishedSha, versionTags) {
  const target = git("rev-parse", "HEAD");
  const ancestor = spawnSync("git", [
    "merge-base", "--is-ancestor", BACKLOG.blockedMainSha, target,
  ]).status === 0;
  const changedPaths = ancestor
    ? git("diff", "--name-only", BACKLOG.blockedMainSha, target).split("\n").filter(Boolean)
    : [];
  const blobs = {};
  for (const path of Object.keys(BACKLOG.immutableBlobs)) {
    blobs[path] = git("rev-parse", "HEAD:" + path);
  }
  return verifyBacklogCandidate({
    publishedTag, publishedSha, changedPaths, blobs,
    sourceIsAncestor: ancestor, versionTags,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    // For PR and merge_group readiness, the repository's main must still be
    // the precise unpublished merge; no generic bypass for other commits.
    const mainSha = git("rev-parse", "origin/main");
    check(mainSha === BACKLOG.blockedMainSha,
      "main moved away from the exact unpublished PR #381 SHA");
    const actualLatest = execFileSync("gh", [
      "api", "repos/" + process.env.GITHUB_REPOSITORY + "/releases/latest",
      "--jq", ".tag_name",
    ], { encoding: "utf8" }).trim();
    const sourceSha = git("rev-list", "-n", "1", actualLatest);
    const tags = git("tag", "--list", "v*").split("\n").filter(Boolean);
    const targetVersion = verifyBacklogCheckout(actualLatest, sourceSha, tags);
    console.log("PASS: pinned recovery candidate " + targetVersion +
      " from unpublished " + BACKLOG.blockedMainSha +
      "; full release and rollback gates remain mandatory.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
