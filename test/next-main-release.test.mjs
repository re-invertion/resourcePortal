import test from "node:test";
import assert from "node:assert/strict";
import { nextMainRelease } from "../scripts/next-main-release.mjs";

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
