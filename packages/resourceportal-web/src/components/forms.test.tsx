import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { JsonPayloadForm, OneTimeCredential } from "./forms";

describe("functional Stage 20 forms", () => {
  it("submits parsed JSON without storing it in browser storage", async () => {
    const submit = vi.fn();
    const localSpy = vi.spyOn(Storage.prototype, "setItem");
    render(<JsonPayloadForm submitLabel="Create" initialValue={{ name: "demo" }} onSubmit={submit} />);

    fireEvent.change(screen.getByLabelText("JSON payload"), {
      target: { value: '{"name":"changed","replicas":2}' },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(submit).toHaveBeenCalledWith({ name: "changed", replicas: 2 });
    expect(localSpy).not.toHaveBeenCalled();
  });

  it("shows invalid JSON as an inline validation error", () => {
    render(<JsonPayloadForm submitLabel="Save" onSubmit={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("JSON payload"), { target: { value: "{" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert").textContent).toContain("Invalid JSON");
  });

  it("keeps one-time credentials only in component memory and can clear them", () => {
    render(<OneTimeCredential value={{ clientId: "client", clientSecret: "once-only" }} />);
    expect(screen.getByText(/once-only/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear credential" }));
    expect(screen.queryByText(/once-only/)).toBeNull();
  });
});
