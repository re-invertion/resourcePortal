import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { JsonPayloadForm, OneTimeCredential } from "./forms";

describe("functional Stage 20 forms", () => {
  it("renders typed fields instead of raw JSON and submits typed values", async () => {
    const submit = vi.fn();
    const localSpy = vi.spyOn(Storage.prototype, "setItem");
    render(
      <JsonPayloadForm
        submitLabel="Create"
        initialValue={{ name: "", replicas: 1, enabled: false }}
        onSubmit={submit}
      />,
    );

    expect(screen.queryByLabelText("JSON payload")).toBeNull();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "demo" } });
    fireEvent.change(screen.getByLabelText("Replicas"), { target: { value: "3" } });
    fireEvent.click(screen.getByLabelText("Enabled"));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(submit).toHaveBeenCalledWith({ name: "demo", replicas: 3, enabled: true });
    expect(localSpy).not.toHaveBeenCalled();
  });

  it("offers addable form fields when an operation has no predefined template", () => {
    render(<JsonPayloadForm submitLabel="Run" onSubmit={vi.fn()} />);

    expect(screen.queryByLabelText("JSON payload")).toBeNull();
    expect(screen.getByRole("button", { name: "Add field" })).toBeTruthy();
    expect(screen.getByLabelText("Field name 1")).toBeTruthy();
    expect(screen.getByLabelText("Field value 1")).toBeTruthy();
  });

  it("keeps optional numeric and boolean fields typed but omits them until set", async () => {
    const submit = vi.fn();
    render(
      <JsonPayloadForm
        submitLabel="Create"
        initialValue={{ desiredReplicas: null, enabled: null }}
        onSubmit={submit}
      />,
    );

    expect(screen.getByLabelText("Desired replicas").getAttribute("type")).toBe("number");
    expect(screen.getByLabelText("Enabled").getAttribute("type")).toBe("checkbox");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(submit).toHaveBeenLastCalledWith({}));
    await screen.findByRole("button", { name: "Create" });

    fireEvent.change(screen.getByLabelText("Desired replicas"), { target: { value: "2" } });
    fireEvent.click(screen.getByLabelText("Enabled"));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(submit).toHaveBeenLastCalledWith({ desiredReplicas: 2, enabled: true }));
  });

  it("uses Formik when the preview runtime has loaded it", () => {
    const useFormik = vi.fn(() => ({
      values: { name: "demo" },
      errors: {} as Record<string, string>,
      isSubmitting: false,
      handleChange: vi.fn(),
      handleSubmit: vi.fn((event: { preventDefault: () => void }) => event.preventDefault()),
      setFieldValue: vi.fn(),
      setSubmitting: vi.fn(),
    }));
    const browser = window as unknown as { Formik?: { useFormik: typeof useFormik } };
    browser.Formik = { useFormik };

    try {
      render(<JsonPayloadForm submitLabel="Create" initialValue={{ name: "demo" }} onSubmit={vi.fn()} />);
      expect(useFormik).toHaveBeenCalledTimes(1);
    } finally {
      delete browser.Formik;
    }
  });

  it("keeps one-time credentials only in component memory and can clear them", () => {
    render(<OneTimeCredential value={{ clientId: "client", clientSecret: "once-only" }} />);
    expect(screen.getByText(/once-only/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear credential" }));
    expect(screen.queryByText(/once-only/)).toBeNull();
  });

  it("shows a newly supplied one-time value after the previous value was cleared", () => {
    const { rerender } = render(<OneTimeCredential value={{ value: "first-once" }} />);

    fireEvent.click(screen.getByRole("button", { name: "Clear credential" }));
    expect(screen.getByText(/Credential cleared from this browser view/)).toBeTruthy();

    rerender(<OneTimeCredential value={{ value: "second-once" }} />);

    expect(screen.getByText(/second-once/)).toBeTruthy();
    expect(screen.queryByText(/Credential cleared from this browser view/)).toBeNull();
  });
});
