import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { StoredSecretInput } from "./stored-secret-input";

function Fixture({ configured = true }: { configured?: boolean }) {
  const [value, setValue] = useState("");
  return (
    <StoredSecretInput
      aria-label="Credential"
      configured={configured}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      placeholder="Enter credential"
    />
  );
}

describe("StoredSecretInput", () => {
  it("shows a presentation-only mask without placing it in the input value", () => {
    render(<Fixture />);
    const input = screen.getByLabelText("Credential") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("");
    expect(screen.getByText("••••••••••••")).toBeTruthy();
    expect(screen.getByText(/Credential configured; value hidden/i)).toBeTruthy();
  });

  it("hides the stored mask while editing and only stores newly typed text", () => {
    render(<Fixture />);
    const input = screen.getByLabelText("Credential") as HTMLInputElement;

    fireEvent.focus(input);
    expect(screen.queryByText("••••••••••••")).toBeNull();
    expect(input.value).toBe("");

    fireEvent.change(input, { target: { value: "replacement-secret" } });
    expect(input.value).toBe("replacement-secret");
    expect(screen.queryByText("••••••••••••")).toBeNull();
  });

  it("uses the normal placeholder when no credential is configured", () => {
    render(<Fixture configured={false} />);
    const input = screen.getByLabelText("Credential") as HTMLInputElement;
    expect(input.placeholder).toBe("Enter credential");
    expect(screen.queryByText("••••••••••••")).toBeNull();
  });
});
