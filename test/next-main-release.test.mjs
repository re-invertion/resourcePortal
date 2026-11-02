import test from "node:test";
import assert from "node:assert/strict";
import { nextMainRelease, alreadyPublishedMainRelease } from "../scripts/next-main-release.mjs";

test("every merge selects a fresh patch version after a failed tag", () => {
  assert.deepEqual(nextMainRelease(["v0.2.75", "v0.2.76"], "v0.2.75"), {
    version: "0.2.77", previousTag: "v0.2.75", mode: "fastfix",
  });
});
test("explicit milestone has full validation", () => {
  assert.equal(nextMainRelease(["v0.2.75"], "v0.2.75", ["v0.2.76"]).mode, "milestone");
});
test("unpublished versions cannot be overwritten", () => {
  assert.throws(() => nextMainRelease(["v0.2.75", "v0.3.0"], "v0.2.75"), /Unpublished milestone/);
  assert.throws(() => nextMainRelease(["v0.2.76"], "v0.2.75"), /must exist/);
});

test("a published SHA is a verified no-op instead of allocating another patch version", () => {
  const sha = "a".repeat(40);
  const names = ["resource-portal-cli-0.2.80.tgz", "resourceportal-release-manifest.json", "SHA256SUMS"];
  assert.deepEqual(alreadyPublishedMainRelease("v0.2.80", sha, sha, names), {
    version: "0.2.80", previousTag: "v0.2.80", mode: "published",
  });
  assert.equal(alreadyPublishedMainRelease("v0.2.80", sha, "b".repeat(40), names), null);
});
test("a published SHA with incomplete release assets fails closed", () => {
  const sha = "a".repeat(40);
  assert.throws(() => alreadyPublishedMainRelease("v0.2.80", sha, sha, ["SHA256SUMS"]), /incomplete/);
});

test("one-time v0.2.130 recovery requires exact old main, reviewed paths and immutable blobs", async () => {
  const { BACKLOG, verifyBacklogCandidate } = await import("../scripts/release-backlog-recovery.mjs");
  const valid = {
    publishedTag: BACKLOG.publishedTag,
    publishedSha: BACKLOG.publishedSha,
    changedPaths: [...BACKLOG.allowedPaths],
    blobs: { ...BACKLOG.immutableBlobs },
    sourceIsAncestor: true,
    versionTags: [BACKLOG.publishedTag],
  };
  assert.equal(verifyBacklogCandidate(valid), "v0.2.130");
  assert.throws(() => verifyBacklogCandidate({ ...valid, publishedTag: "v0.2.129" }),
    /wrong published source tag/);
  assert.throws(() => verifyBacklogCandidate({ ...valid, publishedSha: "f".repeat(40) }),
    /wrong published source SHA/);
  assert.throws(() => verifyBacklogCandidate({ ...valid, sourceIsAncestor: false }),
    /not an ancestor/);
  assert.throws(() => verifyBacklogCandidate({ ...valid,
    changedPaths: [...valid.changedPaths, "packages/resourceportal-api/src/unsafe.ts"] }),
  /candidate file set/);
  assert.throws(() => verifyBacklogCandidate({ ...valid,
    changedPaths: valid.changedPaths.filter((x) => x !== "scripts/publish-tested-release-image.sh") }),
  /candidate file set/);
  assert.throws(() => verifyBacklogCandidate({ ...valid,
    blobs: { ...valid.blobs, "scripts/publish-tested-release-image.sh": "f".repeat(40) } }),
  /reviewed file content differs/);
  assert.throws(() => verifyBacklogCandidate({ ...valid, versionTags: ["v0.2.130"] }),
  /already has a Git tag/);
});
