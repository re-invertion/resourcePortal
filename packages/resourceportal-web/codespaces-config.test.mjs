import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");

describe("Codespaces preview configuration", () => {
  it("opens the private Web Console port and wires lifecycle scripts", () => {
    const config = JSON.parse(readFileSync(path.join(repoRoot, ".devcontainer/devcontainer.json"), "utf8"));

    expect(config.forwardPorts).toContain(5173);
    expect(config.portsAttributes?.["5173"]).toMatchObject({
      label: "ResourcePortal Web Console",
      onAutoForward: "openBrowser",
      visibility: "private",
    });
    expect(config.postCreateCommand).toBe("bash scripts/codespace-setup.sh");
    expect(config.postStartCommand).toBe("bash scripts/codespace-start.sh");
  });

  it("keeps Codespaces lifecycle scripts syntactically valid Bash", () => {
    for (const script of ["scripts/codespace-setup.sh", "scripts/codespace-start.sh"]) {
      expect(() => execFileSync("bash", ["-n", path.join(repoRoot, script)], { stdio: "pipe" })).not.toThrow();
    }
  });
});
