import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmButton, JsonPayloadForm, OneTimeCredential } from "./forms";

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
    expect(screen.getByLabelText("Enabled").tagName).toBe("SELECT");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(submit).toHaveBeenLastCalledWith({}));

    fireEvent.change(screen.getByLabelText("Desired replicas"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Enabled"), { target: { value: "true" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(submit).toHaveBeenLastCalledWith({ desiredReplicas: 2, enabled: true }));
  });

  it("renders closed contract fields as selects with only supported options", () => {
    render(
      <JsonPayloadForm
        submitLabel="Create"
        initialValue={{ protocolMode: "HTTP", type: "Managed", protocol: "OIDC" }}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Protocol mode").tagName).toBe("SELECT");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(expect.arrayContaining([
      "HTTP",
      "HTTPS",
      "HTTP + HTTPS",
      "HTTP → HTTPS",
      "Managed",
      "Custom",
      "OIDC",
      "SAML",
    ]));
  });

  it("renders field guidance next to inputs", () => {
    render(<JsonPayloadForm submitLabel="Create" initialValue={{ containerPort: 80 }} onSubmit={vi.fn()} />);

    expect(screen.getByText(/Port exposed by the application container/i)).toBeTruthy();
  });

  it("renders reference choices as selects instead of free text UUID inputs", () => {
    render(
      <JsonPayloadForm
        submitLabel="Create"
        initialValue={{ registryId: "" }}
        referenceOptions={{ registryId: [{ value: "registry-1", label: "Docker Hub mirror" }] }}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Registry ID").tagName).toBe("SELECT");
    expect(screen.getByRole("option", { name: "Docker Hub mirror" })).toBeTruthy();
  });

  it("passes a Yup validation schema to Formik when the preview runtimes are available", () => {
    const schema = { validate: vi.fn() };
    const yupObject = vi.fn(() => schema);
    const useFormik = vi.fn(() => ({
      values: { containerPort: 80 },
      errors: {} as Record<string, string>,
      touched: {} as Record<string, boolean>,
      isSubmitting: false,
      handleSubmit: vi.fn(),
      setFieldTouched: vi.fn(),
      setFieldValue: vi.fn(),
      setSubmitting: vi.fn(),
    }));
    const browser = window as unknown as {
      Formik?: { useFormik: typeof useFormik };
      Yup?: { object: typeof yupObject; number: () => unknown; string: () => unknown; boolean: () => unknown; array: () => unknown; mixed: () => unknown };
    };
    browser.Formik = { useFormik };
    browser.Yup = {
      object: yupObject,
      number: () => ({ integer: () => ({ min: () => ({ max: () => ({ nullable: () => ({}) }) }) }) }),
      string: () => ({ trim: () => ({ max: () => ({ matches: () => ({ required: () => ({ nullable: () => ({}) }) }) }) }) }),
      boolean: () => ({ nullable: () => ({}) }),
      array: () => ({ of: () => ({ max: () => ({ nullable: () => ({}) }) }) }),
      mixed: () => ({ oneOf: () => ({ nullable: () => ({}) }) }),
    };

    try {
      render(<JsonPayloadForm submitLabel="Create" initialValue={{ containerPort: 80 }} onSubmit={vi.fn()} />);
      expect(useFormik).toHaveBeenCalledWith(expect.objectContaining({ validationSchema: schema }));
    } finally {
      delete browser.Formik;
      delete browser.Yup;
    }
  });

  it("uses Formik when the preview runtime has loaded it", () => {
    const useFormik = vi.fn(() => ({
      values: { name: "demo" },
      errors: {} as Record<string, string>,
      touched: {} as Record<string, boolean>,
      isSubmitting: false,
      handleChange: vi.fn(),
      handleSubmit: vi.fn((event: { preventDefault: () => void }) => event.preventDefault()),
      setFieldTouched: vi.fn(),
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

describe("destructive confirmation", () => {
  it("uses an accessible in-app dialog and only runs the action after confirmation", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(<ConfirmButton confirm="Delete demo application?" onConfirm={onConfirm}>Delete</ConfirmButton>);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByRole("dialog", { name: "Confirm action" })).toBeTruthy();
    expect(screen.getByText("Delete demo application?")).toBeTruthy();
    expect(confirmSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Confirm action" })).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog", { name: "Confirm action" })).toBeNull();
  });
});
