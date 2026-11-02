#!/usr/bin/env node
// Precisely one protected-PR release recovery from the 2026-11-02 failed
// v0.2.130 main publish. No tag writes, bypasses or automatic approval.
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const BACKLOG_131 = Object.freeze({
  publishedTag: "v0.2.128",
  publishedSha: "34bbb1a0b918fb46b71c988fe79c22ee6bf7cca0",
  blockedMainSha: "98f9e94b2b4bcf55cbf791dc38be4a4a6028cb26",
  partiallyPushedTag: "v0.2.130",
  targetTag: "v0.2.131",
  immutableBlobs: Object.freeze({
    "scripts/publish-tested-release-image.sh": "874c35262263da15d305e0b3d41c590ef8e39211",
    "scripts/audit-v02130-release-recovery.mjs": "1a74d77d0d0b697fc9f6b18d8873d978bfc73c24",
  }),
  allowedPaths: Object.freeze([
    ".github/workflows/release-readiness.yml",
    "docs/automatic-main-releases.md",
    "scripts/audit-v02130-release-recovery.mjs",
    "scripts/fastfix-test-plan.mjs",
    "scripts/next-main-release.mjs",
    "scripts/publish-tested-release-image.sh",
    "scripts/release-backlog-131.mjs",
    "test/fastfix-test-plan.test.mjs",
    "test/next-main-release.test.mjs",
    "test/test-upgrade-database-rollback.test.mjs",
    "test/test-workflow-gates.test.mjs",
  ]),
});
const assert = (ok, reason) => { if (!ok) throw new Error("v0.2.131 recovery denied: " + reason); };
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

export function verify131Candidate({ publishedTag, publishedSha, sourceIsAncestor, paths, blobs, versionTags = [] }) {
  assert(publishedTag === BACKLOG_131.publishedTag, "wrong published source tag");
  assert(publishedSha === BACKLOG_131.publishedSha, "wrong published source SHA");
  assert(sourceIsAncestor, "blocked main SHA is not ancestor of candidate");
  assert(JSON.stringify([...paths].sort()) === JSON.stringify([...BACKLOG_131.allowedPaths].sort()),
    "candidate differs from the exact reviewed v0.2.131 recovery file set");
  for (const [path, sha] of Object.entries(BACKLOG_131.immutableBlobs)) {
    assert(blobs[path] === sha, "immutable recovery blob mismatch: " + path);
  }
  assert(!versionTags.includes(BACKLOG_131.targetTag), "v0.2.131 is already tagged; never reuse");
  return BACKLOG_131.targetTag;
}
export function verify131Checkout(publishedTag, publishedSha, versionTags) {
  const target = git("rev-parse", "HEAD");
  const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", BACKLOG_131.blockedMainSha, target]).status === 0;
  const paths = ancestor ? git("diff", "--name-only", BACKLOG_131.blockedMainSha, target).split("\n").filter(Boolean) : [];
  const blobs = Object.fromEntries(Object.keys(BACKLOG_131.immutableBlobs).map(path =>
    [path, git("rev-parse", "HEAD:" + path)]));
  return verify131Candidate({ publishedTag, publishedSha, sourceIsAncestor: ancestor, paths, blobs, versionTags });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assert(git("rev-parse", "origin/main") === BACKLOG_131.blockedMainSha,
      "main has drifted from the exact unpublished SHA 98f9e94");
    const tag = execFileSync("gh", [
      "api", "repos/" + process.env.GITHUB_REPOSITORY + "/releases/latest",
      "--jq", ".tag_name",
    ], { encoding: "utf8" }).trim();
    const sha = git("rev-list", "-n", "1", tag);
    const tags = git("tag", "--list", "v*").split("\n").filter(Boolean);
    console.log("PASS: reviewed recovery to " + verify131Checkout(tag, sha, tags) +
      " from exact unpublished main; all required rollback and signature gates remain enabled.");
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
