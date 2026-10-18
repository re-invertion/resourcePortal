import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testPath = fileURLToPath(new URL("../../../../test/installer/test-gate-discovery-multilan.py", import.meta.url));
describe("LAN agent multihomed discovery", () => {
  it("joins every approved LAN and rejects foreign destinations", () => {
    const output = spawnSync("python3", [testPath], {
      encoding: "utf8", timeout: 10000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    expect(output.status, output.stderr).toBe(0);
  });
});
