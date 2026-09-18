import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(here, "../package.json"), "utf8"));

assert.equal(
  typeof pkg.devDependencies?.playwright,
  "string",
  "browser E2E imports playwright, so the root manifest must declare it explicitly",
);

console.log("PASS: federation browser dependency is declared");
