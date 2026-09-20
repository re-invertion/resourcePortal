import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));

describe("v0.1.9 final UI E2E contract", () => {
  it("waits for the final Tenant Overview heading on the tenant dashboard", () => {
    const script = readFileSync(
      path.resolve(packageRoot, "../../scripts/run-v019-final-ui-e2e.mjs"),
      "utf8",
    );

    expect(script).toContain(
      '.getByRole("heading", { name: "Tenant Overview", level: 1 })',
    );
    expect(script).not.toContain(
      '.getByRole("heading", { name: "Federation E2E", level: 1 })',
    );
  });

  it("checks the final tenant summary card labels", () => {
    const script = readFileSync(
      path.resolve(packageRoot, "../../scripts/run-v019-final-ui-e2e.mjs"),
      "utf8",
    );

    expect(script).toContain(
      '["Applications", "Running workloads", "Storage usage", "Current balance"]',
    );
    expect(script).not.toContain(
      '["Applications", "Runtime", "Balance", "Storage"]',
    );
  });

  it("waits for the final Review & create wizard heading", () => {
    const script = readFileSync(
      path.resolve(packageRoot, "../../scripts/run-v019-final-ui-e2e.mjs"),
      "utf8",
    );

    expect(script).toContain('nextWizardStep(page, "Review & create")');
    expect(script).not.toContain('nextWizardStep(page, "Review")');
  });

  it("uses the final application edit details heading", () => {
    const script = readFileSync(
      path.resolve(packageRoot, "../../scripts/run-v019-final-ui-e2e.mjs"),
      "utf8",
    );

    expect(script).toContain(
      '.getByRole("heading", { name: "Edit application details", level: 3 })',
    );
    expect(script).not.toContain(
      '.getByRole("heading", { name: "Edit application", level: 2 })',
    );
  });

  it("checks the final application edit details heading", () => {
    const script = readFileSync(
      path.resolve(packageRoot, "../../scripts/run-v019-final-ui-e2e.mjs"),
      "utf8",
    );

    expect(script).toContain(
      '.getByRole("heading", { name: "Edit application details", level: 3 })',
    );
    expect(script).not.toContain(
      '.getByRole("heading", { name: "Edit application", level: 2 })',
    );
  });

  it("runs the real-Swarm browser smoke through the final routed UI", () => {
    const script = readFileSync(
      path.resolve(packageRoot, "../../scripts/run-stage20-real-swarm-web-e2e.mjs"),
      "utf8",
    );

    expect(script).toContain(
      '.getByRole("heading", { name: "Choose a tenant", level: 1 })',
    );
    expect(script).toContain(
      '.getByRole("heading", { name: "Applications", level: 1 })',
    );
    expect(script).toContain(
      '.getByRole("button", { name: "Deploy pending changes", exact: true })',
    );
    expect(script).toContain('clickRuntimeAction(');
    expect(script).toContain('"Restart application"');
    expect(script).toContain('runOperationToTerminal');
    expect(script).toContain('"RolledBack"');
    expect(script).not.toContain(
      '.getByRole("heading", { name: "Choose tenant" })',
    );
    expect(script).not.toContain('panelByHeading(page, "AppGroups")');
    expect(script).not.toContain('panelByHeading(page, "SingleApps")');
  });

  it("checks the final v0.1.9 management matrix routes", () => {
    const script = readFileSync(
      path.resolve(packageRoot, "../../scripts/verify-stage20-management-matrix.mjs"),
      "utf8",
    );

    for (const expected of [
      '["overview", "Tenant Overview"]',
      '["applications", "Applications"]',
      '["storage-networking", "Storage & Networking"]',
      '["access", "Access"]',
      '["activity", "Activity"]',
      '["overview", "Platform overview"]',
      '["infrastructure", "Infrastructure"]',
      '["identity-providers", "Identity providers"]',
      '["credentials", "Credentials"]',
      '["security", "Security & operations"]',
    ]) {
      expect(script).toContain(expected);
    }

    expect(script).not.toContain('["overview", "Stage 20 Management Matrix"]');
    expect(script).not.toContain('["app-groups", "AppGroups"]');
    expect(script).not.toContain('["maintenance", "Platform maintenance"]');
  });

});