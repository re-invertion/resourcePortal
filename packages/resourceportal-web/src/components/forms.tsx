import { FormEvent, useEffect, useMemo, useState } from "react";

type JsonFormValues = { payload: string };
type JsonFormHelpers = {
  setFieldError: (field: string, message: string | undefined) => void;
  setSubmitting: (submitting: boolean) => void;
};
type PreviewFormikRuntime = {
  useFormik: (config: {
    initialValues: JsonFormValues;
    enableReinitialize: boolean;
    validateOnBlur: boolean;
    validateOnChange: boolean;
    onSubmit: (values: JsonFormValues, helpers: JsonFormHelpers) => void | Promise<void>;
  }) => {
    values: JsonFormValues;
    errors: Partial<Record<keyof JsonFormValues, string>>;
    isSubmitting: boolean;
    handleChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => void;
    handleSubmit: (event: FormEvent<HTMLFormElement>) => void;
  };
};

type JsonPayloadFormProps = {
  initialValue?: unknown;
  submitLabel: string;
  onSubmit: (value: Record<string, unknown>) => void | Promise<void>;
  disabled?: boolean;
};

function previewFormikRuntime() {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { Formik?: PreviewFormikRuntime }).Formik;
}

function parsePayload(text: string) {
  const parsed = JSON.parse(text || "{}") as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON payload must be an object");
  }
  return parsed as Record<string, unknown>;
}

function payloadError(cause: unknown) {
  return cause instanceof SyntaxError
    ? `Invalid JSON: ${cause.message}`
    : cause instanceof Error
      ? cause.message
      : "Invalid JSON payload";
}

function FormikJsonPayloadForm({
  runtime,
  initialValue,
  submitLabel,
  onSubmit,
  disabled = false,
}: JsonPayloadFormProps & { runtime: PreviewFormikRuntime }) {
  const initial = useMemo(() => JSON.stringify(initialValue ?? {}, null, 2), [initialValue]);
  const formik = runtime.useFormik({
    initialValues: { payload: initial },
    enableReinitialize: true,
    validateOnBlur: false,
    validateOnChange: false,
    onSubmit: async (values, helpers) => {
      helpers.setFieldError("payload", undefined);
      try {
        await onSubmit(parsePayload(values.payload));
      } catch (cause) {
        helpers.setFieldError("payload", payloadError(cause));
      } finally {
        helpers.setSubmitting(false);
      }
    },
  });

  return (
    <form onSubmit={formik.handleSubmit}>
      <label>
        JSON payload
        <textarea
          name="payload"
          aria-label="JSON payload"
          rows={10}
          cols={72}
          value={formik.values.payload}
          onChange={formik.handleChange}
          disabled={disabled || formik.isSubmitting}
        />
      </label>
      {formik.errors.payload ? <p role="alert">{formik.errors.payload}</p> : null}
      <button type="submit" disabled={disabled || formik.isSubmitting}>{formik.isSubmitting ? "Working…" : submitLabel}</button>
    </form>
  );
}

function FallbackJsonPayloadForm({
  initialValue,
  submitLabel,
  onSubmit,
  disabled = false,
}: JsonPayloadFormProps) {
  const initial = useMemo(() => JSON.stringify(initialValue ?? {}, null, 2), [initialValue]);
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => setText(initial), [initial]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    try {
      setSubmitting(true);
      await onSubmit(parsePayload(text));
    } catch (cause) {
      setError(payloadError(cause));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <label>
        JSON payload
        <textarea
          name="payload"
          aria-label="JSON payload"
          rows={10}
          cols={72}
          value={text}
          onChange={(event) => setText(event.target.value)}
          disabled={disabled || submitting}
        />
      </label>
      {error ? <p role="alert">{error}</p> : null}
      <button type="submit" disabled={disabled || submitting}>{submitting ? "Working…" : submitLabel}</button>
    </form>
  );
}

export function JsonPayloadForm(props: JsonPayloadFormProps) {
  const runtime = previewFormikRuntime();
  return runtime ? <FormikJsonPayloadForm {...props} runtime={runtime} /> : <FallbackJsonPayloadForm {...props} />;
}

export function OneTimeCredential({ value }: { value: unknown }) {
  const [credential, setCredential] = useState<unknown>(value);
  useEffect(() => setCredential(value), [value]);

  if (credential == null) return <p>Credential cleared from this browser view.</p>;

  const text = typeof credential === "string" ? credential : JSON.stringify(credential, null, 2);
  return (
    <section aria-label="One-time credential">
      <p><strong>One-time credential.</strong> Copy it now. It is kept only in this page memory and is not persisted by the Web Console.</p>
      <pre>{text}</pre>
      <button type="button" onClick={() => setCredential(null)}>Clear credential</button>
    </section>
  );
}

export function ConfirmButton({
  children,
  confirm,
  onConfirm,
  disabled = false,
}: {
  children: React.ReactNode;
  confirm: string;
  onConfirm: () => void | Promise<void>;
  disabled?: boolean;
}) {
  const [working, setWorking] = useState(false);
  return (
    <button
      type="button"
      disabled={disabled || working}
      onClick={async () => {
        if (!window.confirm(confirm)) return;
        setWorking(true);
        try { await onConfirm(); } finally { setWorking(false); }
      }}
    >
      {working ? "Working…" : children}
    </button>
  );
}
