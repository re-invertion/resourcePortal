import { test } from "node:test";
import { strict as assert } from "node:assert";
import { releaseMode } from "../scripts/release-validation-mode.mjs";

test("third-component semver change is fastfix", () => {
  assert.deepEqual(
    releaseMode("v0.2.66", ["v0.2.64", "v0.2.65"]),
    { version: "v0.2.66", previousTag: "v0.2.65", mode: "fastfix" },
  );
});
test("major and minor changes use full milestone verification", () => {
  assert.equal(releaseMode("v0.3.0", ["v0.2.65"]).mode, "milestone");
  assert.equal(releaseMode("v1.0.0", ["v0.2.65"]).mode, "milestone");
});
test("explicit patch milestone runs full suite", () => {
  assert.equal(releaseMode("v0.2.66", ["v0.2.65"], ["v0.2.66"]).mode, "milestone");
});
test("no previous tag or malformed version fails closed", () => {
  assert.throws(() => releaseMode("v0.2.66", []), /Missing previous/);
  assert.throws(() => releaseMode("v0.2", ["v0.2.65"]), /Invalid semver/);
});
