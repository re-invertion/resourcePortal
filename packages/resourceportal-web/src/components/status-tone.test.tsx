import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { statusTone as designTone, StatusBadge, StatusText, Card } from "./design-system/primitives";
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


describe("#399 status rendering in badges, cards and lists", () => {
  const examples = [
    { value: "Unhealthy", tone: "danger", css: "text-[#C42B1C]" },
    { value: "Invalid", tone: "danger", css: "text-[#C42B1C]" },
    { value: "Unavailable", tone: "danger", css: "text-[#C42B1C]" },
    { value: "RollbackFailed", tone: "danger", css: "text-[#C42B1C]" },
    { value: "Inactive", tone: "neutral", css: "text-[#526070]" },
    { value: "Disabled", tone: "neutral", css: "text-[#526070]" },
    { value: "Unknown", tone: "neutral", css: "text-[#526070]" },
    { value: "Validating", tone: "warning", css: "text-[#9A6700]" },
    { value: "Deploying", tone: "warning", css: "text-[#9A6700]" },
    { value: "Healthy", tone: "success", css: "text-[#137A4A]" },
    { value: "Valid", tone: "success", css: "text-[#137A4A]" },
  ] as const;
  it.each(examples)("renders $value with its own semantic label and $tone tone", ({ value, tone, css }) => {
    const mapped = designTone(value);
    expect(mapped).toBe(tone);
    render(<>
      <Card data-testid="status-card"><StatusBadge tone={mapped}>{value}</StatusBadge></Card>
      <ul data-testid="status-list"><li><StatusText tone={mapped}>{value}</StatusText></li></ul>
    </>);
    const card = screen.getByTestId("status-card");
    const badge = within(card).getByText(value);
    const list = screen.getByTestId("status-list");
    const listText = within(list).getByText(value);
    expect(badge.className).toContain(css);
    const expectedTextColor = tone === "neutral" ? "text-[#5B6678]" : css;
    expect(listText.className).toContain(expectedTextColor);
    expect(badge.textContent).toBe(value);
    expect(listText.textContent).toBe(value);
  });
  it("never turns a compound status sentence or null into a healthy badge", () => {
    for (const value of ["Healthy but unavailable", "Invalid because expired", "not active", null, undefined]) {
      expect(designTone(value)).toBe("neutral");
    }
  });
});
