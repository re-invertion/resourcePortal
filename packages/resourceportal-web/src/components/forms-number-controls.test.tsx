import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { JsonPayloadForm } from "./forms";

describe("numeric form controls", () => {
  it("allows fractional CPU values with native browser validation", () => {
    render(
      <JsonPayloadForm
        submitLabel="Create"
        initialValue={{ cpu: null }}
        onSubmit={vi.fn()}
      />,
    );

    const cpu = screen.getByLabelText(/cpu/i);
    expect(cpu.getAttribute("type")).toBe("number");
    expect(cpu.getAttribute("step")).toBe("any");
  });
});
