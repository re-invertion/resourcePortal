import { FormEvent, useEffect, useMemo, useState } from "react";

type Payload = Record<string, unknown>;
type FormHelpers = { setSubmitting: (submitting: boolean) => void };
type PreviewFormikRuntime = {
  useFormik: (config: {
    initialValues: Payload;
    enableReinitialize: boolean;
    validateOnBlur: boolean;
    validateOnChange: boolean;
    onSubmit: (values: Payload, helpers: FormHelpers) => void | Promise<void>;
  }) => {
    values: Payload;
    isSubmitting: boolean;
    handleSubmit: (event: FormEvent<HTMLFormElement>) => void;
    setFieldValue: (field: string, value: unknown) => void | Promise<unknown>;
  };
};

type JsonPayloadFormProps = {
  initialValue?: unknown;
  submitLabel: string;
  onSubmit: (value: Payload) => void | Promise<void>;
  disabled?: boolean;
};

type DynamicType = "text" | "number" | "boolean" | "list" | "object";
type DynamicRow = { id: number; key: string; type: DynamicType; value: unknown };

let nextRowId = 1;
const rowId = () => nextRowId++;

function previewFormikRuntime() {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { Formik?: PreviewFormikRuntime }).Formik;
}

function isRecord(value: unknown): value is Payload {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function cloneValue<T>(value: T): T {
  if (value == null || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function payloadError(cause: unknown) {
  return cause instanceof Error ? cause.message : "The form could not be submitted";
}

function labelFor(key: string) {
  const spaced = key
    .replace(/Ids\b/g, " IDs")
    .replace(/Id\b/g, " ID")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : "Value";
}

function inferType(value: unknown): DynamicType {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(value)) return "list";
  if (isRecord(value)) return "object";
  return "text";
}

function defaultValue(type: DynamicType): unknown {
  if (type === "number") return "";
  if (type === "boolean") return false;
  if (type === "list") return [""];
  if (type === "object") return {};
  return "";
}

function cleanValue(value: unknown): unknown {
  if (value === "" || value == null) return undefined;
  if (Array.isArray(value)) {
    const cleaned = value.map(cleanValue).filter((item) => item !== undefined);
    return cleaned.length ? cleaned : undefined;
  }
  if (isRecord(value)) {
    const cleaned = Object.entries(value).reduce<Payload>((result, [key, item]) => {
      const next = cleanValue(item);
      if (key && next !== undefined) result[key] = next;
      return result;
    }, {});
    return Object.keys(cleaned).length ? cleaned : undefined;
  }
  return value;
}

function cleanPayload(values: Payload) {
  const cleaned = cleanValue(values);
  return isRecord(cleaned) ? cleaned : {};
}

function shouldUseTextarea(key: string) {
  return ["content", "description", "note", "reason", "value", "credential", "clientSecret"].includes(key);
}

function ArrayField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: unknown[];
  onChange: (value: unknown[]) => void;
  disabled: boolean;
}) {
  const items = value.length ? value : [""];
  const template = value[0] ?? "";
  return (
    <fieldset>
      <legend>{label}</legend>
      {items.map((item, index) => (
        <div key={index}>
          <ValueEditor
            label={`${label} item ${index + 1}`}
            fieldKey={`${label}-${index}`}
            value={item}
            onChange={(next) => {
              const updated = [...items];
              updated[index] = next;
              onChange(updated);
            }}
            disabled={disabled}
          />
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange(items.filter((_, itemIndex) => itemIndex !== index))}
          >
            Remove item
          </button>
        </div>
      ))}
      <button type="button" disabled={disabled} onClick={() => onChange([...items, cloneValue(template)])}>
        Add item
      </button>
    </fieldset>
  );
}

function rowsFromRecord(value: Payload): DynamicRow[] {
  const rows = Object.entries(value).map(([key, item]) => ({ id: rowId(), key, type: inferType(item), value: cloneValue(item) }));
  return rows.length ? rows : [{ id: rowId(), key: "", type: "text", value: "" }];
}

function RecordField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: Payload;
  onChange: (value: Payload) => void;
  disabled: boolean;
}) {
  const [rows, setRows] = useState<DynamicRow[]>(() => rowsFromRecord(value));
  const serialized = JSON.stringify(value);

  useEffect(() => {
    const current = rows.reduce<Payload>((result, row) => {
      if (row.key) result[row.key] = row.value;
      return result;
    }, {});
    if (JSON.stringify(current) !== serialized) setRows(rowsFromRecord(value));
    // Synchronize only when the parent value changes independently.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serialized]);

  function updateRows(updated: DynamicRow[]) {
    setRows(updated);
    onChange(updated.reduce<Payload>((result, row) => {
      if (row.key) result[row.key] = row.value;
      return result;
    }, {}));
  }

  return (
    <fieldset>
      <legend>{label}</legend>
      {rows.map((row, index) => (
        <div key={row.id}>
          <label>
            {`${label} key ${index + 1}`}
            <input
              aria-label={`${label} key ${index + 1}`}
              value={row.key}
              disabled={disabled}
              onChange={(event) => updateRows(rows.map((item) => item.id === row.id ? { ...item, key: event.target.value } : item))}
            />
          </label>
          <label>
            {`${label} type ${index + 1}`}
            <select
              aria-label={`${label} type ${index + 1}`}
              value={row.type}
              disabled={disabled}
              onChange={(event) => {
                const type = event.target.value as DynamicType;
                updateRows(rows.map((item) => item.id === row.id ? { ...item, type, value: defaultValue(type) } : item));
              }}
            >
              <option value="text">Text</option>
              <option value="number">Number</option>
              <option value="boolean">Boolean</option>
              <option value="list">List</option>
              <option value="object">Object</option>
            </select>
          </label>
          <ValueEditor
            label={`${label} value ${index + 1}`}
            fieldKey={`${label}-${row.key || index}`}
            value={row.value}
            forcedType={row.type}
            disabled={disabled}
            onChange={(next) => updateRows(rows.map((item) => item.id === row.id ? { ...item, value: next } : item))}
          />
          <button type="button" disabled={disabled} onClick={() => updateRows(rows.filter((item) => item.id !== row.id))}>
            Remove field
          </button>
        </div>
      ))}
      <button type="button" disabled={disabled} onClick={() => updateRows([...rows, { id: rowId(), key: "", type: "text", value: "" }])}>
        Add field
      </button>
    </fieldset>
  );
}

function ValueEditor({
  label,
  fieldKey,
  value,
  onChange,
  disabled,
  forcedType,
}: {
  label: string;
  fieldKey: string;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled: boolean;
  forcedType?: DynamicType;
}) {
  const type = forcedType ?? inferType(value);
  if (type === "boolean") {
    return (
      <label>
        <input
          type="checkbox"
          aria-label={label}
          checked={Boolean(value)}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        {label}
      </label>
    );
  }
  if (type === "number") {
    return (
      <label>
        {label}
        <input
          type="number"
          aria-label={label}
          value={typeof value === "number" ? value : ""}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value === "" ? "" : Number(event.target.value))}
        />
      </label>
    );
  }
  if (type === "list") {
    return <ArrayField label={label} value={Array.isArray(value) ? value : []} onChange={onChange} disabled={disabled} />;
  }
  if (type === "object") {
    return <RecordField label={label} value={isRecord(value) ? value : {}} onChange={onChange} disabled={disabled} />;
  }
  if (shouldUseTextarea(fieldKey)) {
    return (
      <label>
        {label}
        <textarea aria-label={label} rows={4} value={typeof value === "string" ? value : ""} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
      </label>
    );
  }
  return (
    <label>
      {label}
      <input aria-label={label} value={typeof value === "string" ? value : ""} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function ObjectShapeFields({
  values,
  onChange,
  disabled,
}: {
  values: Payload;
  onChange: (field: string, value: unknown) => void;
  disabled: boolean;
}) {
  return <>{Object.entries(values).map(([key, value]) => (
    <ValueEditor
      key={key}
      label={labelFor(key)}
      fieldKey={key}
      value={value}
      onChange={(next) => onChange(key, next)}
      disabled={disabled}
    />
  ))}</>;
}

function FormikStructuredPayloadForm({
  runtime,
  initialValue,
  submitLabel,
  onSubmit,
  disabled = false,
}: JsonPayloadFormProps & { runtime: PreviewFormikRuntime; initialValue: Payload }) {
  const initial = useMemo(() => cloneValue(initialValue), [initialValue]);
  const [error, setError] = useState<string>();
  const formik = runtime.useFormik({
    initialValues: initial,
    enableReinitialize: true,
    validateOnBlur: false,
    validateOnChange: false,
    onSubmit: async (values, helpers) => {
      setError(undefined);
      try {
        await onSubmit(cleanPayload(values));
      } catch (cause) {
        setError(payloadError(cause));
      } finally {
        helpers.setSubmitting(false);
      }
    },
  });

  return (
    <form onSubmit={formik.handleSubmit}>
      <ObjectShapeFields
        values={formik.values}
        disabled={disabled || formik.isSubmitting}
        onChange={(field, value) => { void formik.setFieldValue(field, value); }}
      />
      {error ? <p role="alert">{error}</p> : null}
      <button type="submit" disabled={disabled || formik.isSubmitting}>{formik.isSubmitting ? "Working…" : submitLabel}</button>
    </form>
  );
}

function FallbackStructuredPayloadForm({
  initialValue,
  submitLabel,
  onSubmit,
  disabled = false,
}: JsonPayloadFormProps & { initialValue: Payload }) {
  const initial = useMemo(() => cloneValue(initialValue), [initialValue]);
  const [values, setValues] = useState<Payload>(initial);
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => setValues(cloneValue(initial)), [initial]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    try {
      setSubmitting(true);
      await onSubmit(cleanPayload(values));
    } catch (cause) {
      setError(payloadError(cause));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <ObjectShapeFields
        values={values}
        disabled={disabled || submitting}
        onChange={(field, value) => setValues((current) => ({ ...current, [field]: value }))}
      />
      {error ? <p role="alert">{error}</p> : null}
      <button type="submit" disabled={disabled || submitting}>{submitting ? "Working…" : submitLabel}</button>
    </form>
  );
}

function DynamicPayloadForm({ submitLabel, onSubmit, disabled = false }: JsonPayloadFormProps) {
  const [rows, setRows] = useState<DynamicRow[]>([{ id: rowId(), key: "", type: "text", value: "" }]);
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    try {
      setSubmitting(true);
      const payload = rows.reduce<Payload>((result, row) => {
        const key = row.key.trim();
        const value = cleanValue(row.value);
        if (key && value !== undefined) result[key] = value;
        return result;
      }, {});
      await onSubmit(payload);
    } catch (cause) {
      setError(payloadError(cause));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit}>
      {rows.map((row, index) => (
        <fieldset key={row.id}>
          <legend>{`Field ${index + 1}`}</legend>
          <label>
            Field name
            <input
              aria-label={`Field name ${index + 1}`}
              value={row.key}
              disabled={disabled || submitting}
              onChange={(event) => setRows((current) => current.map((item) => item.id === row.id ? { ...item, key: event.target.value } : item))}
            />
          </label>
          <label>
            Field type
            <select
              aria-label={`Field type ${index + 1}`}
              value={row.type}
              disabled={disabled || submitting}
              onChange={(event) => {
                const type = event.target.value as DynamicType;
                setRows((current) => current.map((item) => item.id === row.id ? { ...item, type, value: defaultValue(type) } : item));
              }}
            >
              <option value="text">Text</option>
              <option value="number">Number</option>
              <option value="boolean">Boolean</option>
              <option value="list">List</option>
              <option value="object">Object</option>
            </select>
          </label>
          <ValueEditor
            label={`Field value ${index + 1}`}
            fieldKey={row.key}
            value={row.value}
            forcedType={row.type}
            disabled={disabled || submitting}
            onChange={(value) => setRows((current) => current.map((item) => item.id === row.id ? { ...item, value } : item))}
          />
          <button type="button" disabled={disabled || submitting} onClick={() => setRows((current) => current.filter((item) => item.id !== row.id))}>
            Remove field
          </button>
        </fieldset>
      ))}
      <button type="button" disabled={disabled || submitting} onClick={() => setRows((current) => [...current, { id: rowId(), key: "", type: "text", value: "" }])}>
        Add field
      </button>
      {error ? <p role="alert">{error}</p> : null}
      <button type="submit" disabled={disabled || submitting}>{submitting ? "Working…" : submitLabel}</button>
    </form>
  );
}

export function JsonPayloadForm(props: JsonPayloadFormProps) {
  const initial = isRecord(props.initialValue) ? props.initialValue : undefined;
  if (!initial || Object.keys(initial).length === 0) return <DynamicPayloadForm {...props} />;
  const runtime = previewFormikRuntime();
  return runtime
    ? <FormikStructuredPayloadForm {...props} initialValue={initial} runtime={runtime} />
    : <FallbackStructuredPayloadForm {...props} initialValue={initial} />;
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
