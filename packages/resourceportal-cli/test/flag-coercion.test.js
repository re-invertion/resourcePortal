const test = require("node:test");
const assert = require("node:assert/strict");
const { coerceCliFlag } = require("../dist/flag-coercion.js");

test("CLI preserves exact textual values for variable, config, secret and metadata DTOs (#259)", () => {
  for (const key of ["value", "content", "name", "description", "fileName", "clientId", "clientSecret", "username", "credential", "containerUser"]) {
    for (const text of ["00123", "123", "true", "false", "1.50"]) {
      assert.equal(coerceCliFlag(key, text), text, `${key}=${text}`);
    }
  }
});

test("CLI still converts explicitly numeric/bool typed legacy flags", () => {
  assert.equal(coerceCliFlag("cpu", "0.5"), 0.5);
  assert.equal(coerceCliFlag("desiredReplicas", "4"), 4);
  assert.equal(coerceCliFlag("enabled", "false"), false);
  assert.equal(coerceCliFlag("usePkce", "true"), true);
  assert.equal(coerceCliFlag("sizeBytes", "1048576"), 1048576);
});
