import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { statusTone as designTone, StatusBadge } from "./design-system/primitives";
import { statusTone as legacyTone, StatusBadge as LegacyBadge } from "./ui";

describe("status mapping – exact semantic enum", () => {
  it.each([
    ["Unhealthy", "danger"], ["Failed", "danger"], ["Error", "danger"],
    ["Invalid", "danger"], ["RollbackFailed", "danger"],
    ["Unavailable", "danger"], ["Inactive", "neutral"],
    ["Disabled", "neutral"], ["Unknown", "neutral"], ["Not deployed", "neutral"],
    ["Healthy", "success"], ["Succeeded", "success"], ["Valid", "success"],
    ["Pending", "warning"], ["Validating", "warning"], ["PreparingArtifacts", "warning"],
    ["GeneratingStack", "warning"], ["ApplyingStack", "warning"], ["WaitingForRollout", "warning"],
    ["Creating", "warning"], ["Resizing", "warning"], ["RolledBack", "warning"],
    ["Deploying", "warning"], ["Issuing", "warning"],
    ["Suspended", "danger"], ["Drifted", "danger"],
    ["Healthy but unavailable", "neutral"], ["", "neutral"],
  ] as const)("maps %s to %s without substring matching", (input, expected) => {
    expect(designTone(input)).toBe(expected);
  });

  it("renders a text-bearing badge and never colors Unhealthy as success", () => {
    render(<StatusBadge tone={designTone("Unhealthy")}>Unhealthy</StatusBadge>);
    expect(screen.getByText("Unhealthy").className).toContain("text-[#C42B1C]");
  });

  it("legacy and design-system status mappings agree on unsafe statuses", () => {
    expect(legacyTone("Unhealthy")).toBe("negative");
    expect(legacyTone("Validating")).toBe("warning");
    expect(legacyTone("Inactive")).toBe("neutral");
    render(<LegacyBadge>Unhealthy</LegacyBadge>);
    expect(screen.getByText("Unhealthy").getAttribute("data-tone")).toBe("negative");
  });
});
