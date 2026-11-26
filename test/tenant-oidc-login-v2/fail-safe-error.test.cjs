"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { safeFailureLine } = require("./fail-safe-error.cjs");
test("failed browser navigation never leaks OAuth user_code, URL, token or stack", () => {
  const marker = "SYNTHETIC-SENSITIVE-USER-CODE-NEVER-PRINT";
  const browserError = new Error(
    "page.goto: Timeout 30000ms exceeded https://localhost:8443/ui/v2/login/device?user_code=" +
    marker + " access_token=" + marker);
  browserError.name = "TimeoutError";
  browserError.stack = "at " + marker;
  const result = safeFailureLine("device-no-implicit-consent", browserError);
  assert.match(result, /device-no-implicit-consent/);
  assert.match(result, /TimeoutError/);
  assert.doesNotMatch(result, /user_code|access_token|https:\/\/|SYNTHETIC-SENSITIVE|page\.goto/i);
  assert.equal(safeFailureLine("https://localhost:8443/?user_code=" + marker,
    { name: marker, message: marker }), "BLOCKED: real isolated Login V2 consent E2E: stage=unclassified; error=OtherError; details suppressed");
});
test("no untrusted error detail reaches CI diagnostics", () => {
  const error={ name:"AssertionError", message:"Bearer secret", stack:"device_code=secret" };
  const safe=safeFailureLine("device-explicit-allow",error);
  assert.match(safe,/stage=device-explicit-allow; error=AssertionError/);
  assert.doesNotMatch(safe,/Bearer|secret|device_code/);
});

test("allow-path diagnostics identify only a static stage without leaking credentials", () => {
  const secret = "SYNTHETIC-DEVICE-SECRET";
  for (const stage of ["device-allow-request", "device-allow-entry", "device-allow-controls",
    "device-allow-pending", "device-allow-decision", "device-allow-token-poll", "device-allow-token-verify"]) {
    const line = safeFailureLine(stage, {name:"AssertionError",message:secret,stack:secret});
    assert.equal(line, "BLOCKED: real isolated Login V2 consent E2E: stage=" + stage + "; error=AssertionError; details suppressed");
    assert.ok(!line.includes(secret));
  }
});
