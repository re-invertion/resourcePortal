import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("supported deployment entrypoints", () => {
  it("does not ship the retired browser-hosted developer runtime", () => {
    const retired = [
      ".devcontainer/devcontainer.json",
      ".github/workflows/codespaces-preview.yml",
      "scripts/codespace-setup.sh",
      "scripts/codespace-start.sh",
    ];
    for (const relative of retired) {
      expect(existsSync(join(repoRoot, relative)), relative).toBe(false);
    }
  });

  it("keeps production and real infrastructure gates available", () => {
    for (const relative of [
      ".github/workflows/ci.yml",
      ".github/workflows/swarm-integration.yml",
      ".github/workflows/federation-integration.yml",
      ".github/workflows/production-installer.yml",
      "config/production/stack.yml.tpl",
    ]) expect(existsSync(join(repoRoot, relative)), relative).toBe(true);
    const stack = readFileSync(join(repoRoot, "config/production/stack.yml.tpl"), "utf8");
    expect(stack).toContain("AUTH_MODE: zitadel");
  });
});
