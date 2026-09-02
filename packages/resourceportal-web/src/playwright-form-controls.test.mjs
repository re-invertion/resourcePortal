import { describe, expect, it, vi } from "vitest";
import { fillPlaywrightControl } from "../../../scripts/playwright-form-controls.mjs";

function createControl(tagName) {
  return {
    evaluate: vi.fn().mockResolvedValue(tagName),
    fill: vi.fn().mockResolvedValue(undefined),
    selectOption: vi.fn().mockResolvedValue(undefined),
  };
}

describe("fillPlaywrightControl", () => {
  it("uses selectOption for select controls", async () => {
    const control = createControl("SELECT");

    await fillPlaywrightControl(control, "Running");

    expect(control.selectOption).toHaveBeenCalledWith("Running");
    expect(control.fill).not.toHaveBeenCalled();
  });

  it("uses fill for text-like controls", async () => {
    const control = createControl("INPUT");

    await fillPlaywrightControl(control, "example");

    expect(control.fill).toHaveBeenCalledWith("example");
    expect(control.selectOption).not.toHaveBeenCalled();
  });
});
