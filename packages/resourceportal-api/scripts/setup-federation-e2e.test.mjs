import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "setup-federation-e2e.ts"), "utf8");

describe("federation E2E provisioning fixture", () => {
  it("upserts the deterministic admin user so provision can be rerun", () => {
    expect(source).toMatch(/await\s+prisma\.user\.upsert\s*\(/);
    expect(source).not.toMatch(/await\s+prisma\.user\.create\s*\(/);
  });
});
