import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  booleanFieldKeys,
  buildYupSchema,
  choicesFor,
  descriptionFor,
  numericFieldKeys,
  requiredFieldKeys,
  type PreviewYupRuntime,
  type ReferenceOptions,
} from "./form-contracts";
import { useAutomaticReferenceOptions } from "./reference-options";

export type { ReferenceOption, ReferenceOptions } from "./form-contracts";

type Payload = Record<string, unknown>;
type FormHelpers = { setSubmitting: (submitting: boolean) => void };
type PreviewFormikRuntime = {
  useFormik: (config: {
    initialValues: Payload;
    enableReinitialize: boolean;
    validateOnBlur: boolean;
    validateOnChange: boolean;
    validationSchema?: unknown;
    onSubmit: (values: Payload, helpers: FormHelpers) => void | Promise<void>;
  }) => {
    values: Payload;
    errors?: Record<string, unknown>;
    touched?: Record<string, unknown>;
    isSubmitting: boolean;
    handleSubmit: (event: FormEvent<HTMLFormElement>) => void;
    setFieldValue: (field: string, value: unknown, validate?: boolean) => void | Promise<unknown>;
  };
};

type JsonPayloadFormProps = {
  initialValue?: unknown;
  submitLabel: string;
  onSubmit: (value: Payload) => void | Promise<void>;
  disabled?: boolean;
  referenceOptions?: ReferenceOptions;
};

type DynamicType = "text" | "number" | "boolean" | "list" | "object";
type DynamicRow = { id: number; key: string; type: DynamicType; value: unknown };

let nextRowId = 1;
const rowId = () => nextRowId++;

function previewFormikRuntime() {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { Formik?: PreviewFormikRuntime }).Formik;
}

function previewYupRuntime() {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { Yup?: PreviewYupRuntime }).Yup;
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
  if (!spaced) return "Value";
  return spaced.split(/\s+/).map((word, index) => {
    if (word === "ID" || word === "IDs") return word;
    const normalized = word.toLowerCase();
    return index === 0 ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : normalized;
  }).join(" ");
}

function inferType(value: unknown): DynamicType {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(value)) return "list";
  if (isRecord(value)) return "object";
  return "text";
}

function fieldType(key: string, value: unknown): DynamicType {
  if (value == null) {
    if (numericFieldKeys.has(key)) return "number";
    if (booleanFieldKeys.has(key)) return "boolean";
  }
  return inferType(value);
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

function FieldHelp({ fieldKey, error }: { fieldKey: string; error?: string }) {
  return <><small id={`${fieldKey}-help`}>{descriptionFor(fieldKey, labelFor(fieldKey))}</small>{error ? <p role="alert">{error}</p> : null}</>;
}

function ArrayField({ label, fieldKey, value, onChange, disabled, references }: {
  label: string;
  fieldKey: string;
  value: unknown[];
  onChange: (value: unknown[]) => void;
  disabled: boolean;
  references?: ReferenceOptions;
}) {
  const choices = choicesFor(fieldKey, value, references);
  const initialTemplate = useRef<unknown>(cloneValue(value[0] ?? ""));
  if (choices) {
    return <label>{label}<select multiple aria-label={label} aria-describedby={`${fieldKey}-help`} value={value.filter((item): item is string => typeof item === "string")} disabled={disabled} onChange={(event) => onChange(Array.from(event.currentTarget.selectedOptions, (option) => option.value))}>{choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select><FieldHelp fieldKey={fieldKey} /></label>;
  }
  const items = value.length ? value : [];
  return (
    <fieldset>
      <legend>{label}</legend>
      <FieldHelp fieldKey={fieldKey} />
      {items.map((item, index) => (
        <div key={index}>
          <ValueEditor label={`${label} item ${index + 1}`} fieldKey={fieldKey} value={item} onChange={(next) => { const updated = [...items]; updated[index] = next; onChange(updated); }} disabled={disabled} references={references} />
          <button type="button" disabled={disabled} onClick={() => onChange(items.filter((_, itemIndex) => itemIndex !== index))}>Remove item</button>
        </div>
      ))}
      <button type="button" disabled={disabled} onClick={() => onChange([...items, cloneValue(initialTemplate.current)])}>Add item</button>
    </fieldset>
  );
}

function rowsFromRecord(value: Payload): DynamicRow[] {
  const rows = Object.entries(value).map(([key, item]) => ({ id: rowId(), key, type: fieldType(key, item), value: cloneValue(item) }));
  return rows.length ? rows : [{ id: rowId(), key: "", type: "text", value: "" }];
}

function RecordField({ label, value, onChange, disabled }: { label: string; value: Payload; onChange: (value: Payload) => void; disabled: boolean }) {
  const [rows, setRows] = useState<DynamicRow[]>(() => rowsFromRecord(value));
  const serialized = JSON.stringify(value);
  useEffect(() => {
    const current = rows.reduce<Payload>((result, row) => { if (row.key) result[row.key] = row.value; return result; }, {});
    if (JSON.stringify(current) !== serialized) setRows(rowsFromRecord(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serialized]);
  function updateRows(updated: DynamicRow[]) {
    setRows(updated);
    onChange(updated.reduce<Payload>((result, row) => { if (row.key) result[row.key] = row.value; return result; }, {}));
  }
  return (
    <fieldset>
      <legend>{label}</legend>
      {rows.map((row, index) => <div key={row.id}>
        <label>{`${label} key ${index + 1}`}<input aria-label={`${label} key ${index + 1}`} value={row.key} disabled={disabled} onChange={(event) => updateRows(rows.map((item) => item.id === row.id ? { ...item, key: event.target.value } : item))} /></label>
        <label>{`${label} type ${index + 1}`}<select aria-label={`${label} type ${index + 1}`} value={row.type} disabled={disabled} onChange={(event) => { const type = event.target.value as DynamicType; updateRows(rows.map((item) => item.id === row.id ? { ...item, type, value: defaultValue(type) } : item)); }}><option value="text">Text</option><option value="number">Number</option><option value="boolean">Boolean</option><option value="list">List</option><option value="object">Object</option></select></label>
        <ValueEditor label={`${label} value ${index + 1}`} fieldKey={row.key || `${label}-${index}`} value={row.value} forcedType={row.type} disabled={disabled} onChange={(next) => updateRows(rows.map((item) => item.id === row.id ? { ...item, value: next } : item))} />
        <button type="button" disabled={disabled} onClick={() => updateRows(rows.filter((item) => item.id !== row.id))}>Remove field</button>
      </div>)}
      <button type="button" disabled={disabled} onClick={() => updateRows([...rows, { id: rowId(), key: "", type: "text", value: "" }])}>Add field</button>
    </fieldset>
  );
}

function ValueEditor({ label, fieldKey, value, onChange, disabled, forcedType, references, error }: {
  label: string;
  fieldKey: string;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled: boolean;
  forcedType?: DynamicType;
  references?: ReferenceOptions;
  error?: string;
}) {
  const type = forcedType ?? fieldType(fieldKey, value);
  const choices = forcedType ? undefined : choicesFor(fieldKey, value, references);
  if (choices && type !== "list") {
    return <label>{label}<select aria-label={label} aria-describedby={`${fieldKey}-help`} value={typeof value === "string" ? value : ""} required={requiredFieldKeys.has(fieldKey)} disabled={disabled} onChange={(event) => onChange(event.target.value)}><option value="">Choose…</option>{choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select><FieldHelp fieldKey={fieldKey} error={error} /></label>;
  }
  if (type === "boolean") {
    if (value == null) return <label>{label}<select aria-label={label} aria-describedby={`${fieldKey}-help`} value="" disabled={disabled} onChange={(event) => onChange(event.target.value === "" ? null : event.target.value === "true")}><option value="">Not set</option><option value="true">Yes</option><option value="false">No</option></select><FieldHelp fieldKey={fieldKey} error={error} /></label>;
    return <label><input type="checkbox" aria-label={label} aria-describedby={`${fieldKey}-help`} checked={Boolean(value)} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />{label}<FieldHelp fieldKey={fieldKey} error={error} /></label>;
  }
  if (type === "number") {
    return <label>{label}<input type="number" aria-label={label} aria-describedby={`${fieldKey}-help`} min={fieldKey === "containerPort" ? 1 : 0} max={fieldKey === "containerPort" ? 65535 : undefined} step={fieldKey === "cpu" ? "any" : 1} required={requiredFieldKeys.has(fieldKey)} value={typeof value === "number" ? value : ""} disabled={disabled} onChange={(event) => onChange(event.target.value === "" ? null : Number(event.target.value))} /><FieldHelp fieldKey={fieldKey} error={error} /></label>;
  }
  if (type === "list") return <ArrayField label={label} fieldKey={fieldKey} value={Array.isArray(value) ? value : []} onChange={onChange} disabled={disabled} references={references} />;
  if (type === "object") return <RecordField label={label} value={isRecord(value) ? value : {}} onChange={onChange} disabled={disabled} />;
  const inputProps = {
    "aria-label": label,
    "aria-describedby": `${fieldKey}-help`,
    required: requiredFieldKeys.has(fieldKey),
    value: typeof value === "string" ? value : "",
    disabled,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(event.target.value),
  };
  return <label>{label}{shouldUseTextarea(fieldKey) ? <textarea {...inputProps} rows={4} /> : <input {...inputProps} type={fieldKey === "email" || fieldKey === "contactEmail" ? "email" : fieldKey === "issuer" || fieldKey === "metadataUrl" ? "url" : "text"} />}<FieldHelp fieldKey={fieldKey} error={error} /></label>;
}

function ObjectShapeFields({ values, onChange, disabled, references, errors, touched }: {
  values: Payload;
  onChange: (field: string, value: unknown) => void;
  disabled: boolean;
  references?: ReferenceOptions;
  errors?: Record<string, unknown>;
  touched?: Record<string, unknown>;
}) {
  return <>{Object.entries(values).map(([key, value]) => <ValueEditor key={key} label={labelFor(key)} fieldKey={key} value={value} onChange={(next) => onChange(key, next)} disabled={disabled} references={references} error={touched?.[key] && typeof errors?.[key] === "string" ? String(errors[key]) : undefined} />)}</>;
}

function FormikStructuredPayloadForm({ runtime, initialValue, submitLabel, onSubmit, disabled = false, referenceOptions }: JsonPayloadFormProps & { runtime: PreviewFormikRuntime; initialValue: Payload }) {
  const initial = useMemo(() => cloneValue(initialValue), [initialValue]);
  const [error, setError] = useState<string>();
  const yup = previewYupRuntime();
  const validationSchema = useMemo(() => yup ? buildYupSchema(initial, yup, referenceOptions, fieldType, labelFor) : undefined, [initial, yup, referenceOptions]);
  const formik = runtime.useFormik({
    initialValues: initial,
    enableReinitialize: true,
    validateOnBlur: true,
    validateOnChange: true,
    validationSchema,
    onSubmit: async (values, helpers) => {
      setError(undefined);
      try { await onSubmit(cleanPayload(values)); }
      catch (cause) { setError(payloadError(cause)); }
      finally { helpers.setSubmitting(false); }
    },
  });
  return <form onSubmit={formik.handleSubmit}><ObjectShapeFields values={formik.values} disabled={disabled || formik.isSubmitting} references={referenceOptions} errors={formik.errors} touched={formik.touched} onChange={(field, value) => { void formik.setFieldValue(field, value, true); }} />{error ? <p role="alert">{error}</p> : null}<button type="submit" disabled={disabled || formik.isSubmitting}>{formik.isSubmitting ? "Working…" : submitLabel}</button></form>;
}

function FallbackStructuredPayloadForm({ initialValue, submitLabel, onSubmit, disabled = false, referenceOptions }: JsonPayloadFormProps & { initialValue: Payload }) {
  const initial = useMemo(() => cloneValue(initialValue), [initialValue]);
  const [values, setValues] = useState<Payload>(initial);
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => setValues(cloneValue(initial)), [initial]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    try { setSubmitting(true); await onSubmit(cleanPayload(values)); }
    catch (cause) { setError(payloadError(cause)); }
    finally { setSubmitting(false); }
  }
  return <form onSubmit={submit}><ObjectShapeFields values={values} disabled={disabled || submitting} references={referenceOptions} onChange={(field, value) => setValues((current) => ({ ...current, [field]: value }))} />{error ? <p role="alert">{error}</p> : null}<button type="submit" disabled={disabled || submitting}>{submitting ? "Working…" : submitLabel}</button></form>;
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
      const payload = rows.reduce<Payload>((result, row) => { const key = row.key.trim(); const value = cleanValue(row.value); if (key && value !== undefined) result[key] = value; return result; }, {});
      await onSubmit(payload);
    } catch (cause) { setError(payloadError(cause)); }
    finally { setSubmitting(false); }
  }
  return (
    <form onSubmit={submit}>
      {rows.map((row, index) => <fieldset key={row.id}><legend>{`Field ${index + 1}`}</legend><label>Field name<input aria-label={`Field name ${index + 1}`} value={row.key} disabled={disabled || submitting} onChange={(event) => setRows((current) => current.map((item) => item.id === row.id ? { ...item, key: event.target.value } : item))} /></label><label>Field type<select aria-label={`Field type ${index + 1}`} value={row.type} disabled={disabled || submitting} onChange={(event) => { const type = event.target.value as DynamicType; setRows((current) => current.map((item) => item.id === row.id ? { ...item, type, value: defaultValue(type) } : item)); }}><option value="text">Text</option><option value="number">Number</option><option value="boolean">Boolean</option><option value="list">List</option><option value="object">Object</option></select></label><ValueEditor label={`Field value ${index + 1}`} fieldKey={row.key} value={row.value} forcedType={row.type} disabled={disabled || submitting} onChange={(value) => setRows((current) => current.map((item) => item.id === row.id ? { ...item, value } : item))} /><button type="button" disabled={disabled || submitting} onClick={() => setRows((current) => current.filter((item) => item.id !== row.id))}>Remove field</button></fieldset>)}
      <button type="button" disabled={disabled || submitting} onClick={() => setRows((current) => [...current, { id: rowId(), key: "", type: "text", value: "" }])}>Add field</button>
      {error ? <p role="alert">{error}</p> : null}
      <button type="submit" disabled={disabled || submitting}>{submitting ? "Working…" : submitLabel}</button>
    </form>
  );
}

export function JsonPayloadForm(props: JsonPayloadFormProps) {
  const initial = isRecord(props.initialValue) ? props.initialValue : undefined;
  const referenceOptions = useAutomaticReferenceOptions(initial, props.referenceOptions);
  if (!initial || Object.keys(initial).length === 0) return <DynamicPayloadForm {...props} referenceOptions={referenceOptions} />;
  const runtime = previewFormikRuntime();
  const effectiveProps = { ...props, referenceOptions };
  return runtime ? <FormikStructuredPayloadForm {...effectiveProps} initialValue={initial} runtime={runtime} /> : <FallbackStructuredPayloadForm {...effectiveProps} initialValue={initial} />;
}

export function OneTimeCredential({ value }: { value: unknown }) {
  const [credential, setCredential] = useState<unknown>(value);
  useEffect(() => setCredential(value), [value]);
  if (credential == null) return <p>Credential cleared from this browser view.</p>;
  const text = typeof credential === "string" ? credential : JSON.stringify(credential, null, 2);
  return <section aria-label="One-time credential"><p><strong>One-time credential.</strong> Copy it now. It is kept only in this page memory and is not persisted by the Web Console.</p><pre>{text}</pre><button type="button" onClick={() => setCredential(null)}>Clear credential</button></section>;
}

export function ConfirmButton({ children, confirm, onConfirm, disabled = false }: { children: React.ReactNode; confirm: string; onConfirm: () => void | Promise<void>; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const run = async () => {
    setWorking(true);
    try {
      await onConfirm();
      setOpen(false);
    } finally {
      setWorking(false);
    }
  };
  return <>
    <button type="button" disabled={disabled || working} onClick={() => setOpen(true)}>{working ? "Working…" : children}</button>
    {open ? <div className="rp-dialog-backdrop"><section className="rp-confirm-dialog" role="dialog" aria-modal="true" aria-label="Confirm action"><h2>Confirm action</h2><p>{confirm}</p><div className="rp-dialog-actions"><button type="button" disabled={working} onClick={() => setOpen(false)}>Cancel</button><button type="button" disabled={working} onClick={() => void run()}>{working ? "Working…" : "Confirm"}</button></div></section></div> : null}
  </>;
}
