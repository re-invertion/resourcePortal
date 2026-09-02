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

  it("falls back from a missing list item control to the visible multi-select", async () => {
    const fallback = createControl("SELECT");
    const first = vi.fn(() => fallback);
    const filter = vi.fn(() => ({ first }));
    const getByLabel = vi.fn(() => ({ filter }));
    const control = {
      evaluate: vi.fn().mockRejectedValue(new Error("locator missing")),
      toString: vi.fn(() => "getByLabel('Role IDs item 1', { exact: true })"),
      page: vi.fn(() => ({ getByLabel })),
    };

    await fillPlaywrightControl(control, "viewer");

    expect(getByLabel).toHaveBeenCalledWith("Role IDs", { exact: true });
    expect(filter).toHaveBeenCalledWith({ visible: true });
    expect(first).toHaveBeenCalled();
    expect(fallback.selectOption).toHaveBeenCalledWith("viewer");
  });
});
