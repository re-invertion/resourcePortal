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
