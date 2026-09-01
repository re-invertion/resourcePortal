import { FormEvent, useEffect, useMemo, useState } from "react";

export function JsonPayloadForm({
  initialValue = {},
  submitLabel,
  onSubmit,
  disabled = false,
}: {
  initialValue?: unknown;
  submitLabel: string;
  onSubmit: (value: Record<string, unknown>) => void | Promise<void>;
  disabled?: boolean;
}) {
  const initial = useMemo(() => JSON.stringify(initialValue, null, 2), [initialValue]);
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => setText(initial), [initial]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    try {
      const parsed = JSON.parse(text || "{}") as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("JSON payload must be an object");
      }
      setSubmitting(true);
      await onSubmit(parsed as Record<string, unknown>);
    } catch (cause) {
      setError(cause instanceof SyntaxError ? `Invalid JSON: ${cause.message}` : cause instanceof Error ? cause.message : "Invalid JSON payload");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <label>
        JSON payload
        <textarea
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
