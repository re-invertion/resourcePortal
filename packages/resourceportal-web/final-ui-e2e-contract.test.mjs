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

});