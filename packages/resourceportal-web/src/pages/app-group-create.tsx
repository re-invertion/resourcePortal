import { useState } from "react";
import { apiRequest } from "../api/client";
import { ErrorState } from "../components/resource";
import { ResourceIcon } from "../components/icons";

export type AppGroupCreateDraft = {
  name: string;
  description: string;
  runtimeState: "Stopped" | "Running";
};

type CreatedAppGroup = { id?: string };

export function AppGroupCreateWizard({
  tenantId,
  onCancel,
  onCreated,
}: {
  tenantId: string;
  onCancel: () => void;
  onCreated: (id?: string) => void | Promise<void>;
}) {
  const [draft, setDraft] = useState<AppGroupCreateDraft>({ name: "", description: "", runtimeState: "Stopped" });
  const [step, setStep] = useState<"basics" | "review">("basics");
  const [validationError, setValidationError] = useState<string>();
  const [error, setError] = useState<unknown>();
  const [working, setWorking] = useState(false);

  function update<K extends keyof AppGroupCreateDraft>(key: K, value: AppGroupCreateDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setValidationError(undefined);
  }

  function review() {
    if (!draft.name.trim()) {
      setValidationError("Name is required before you can review this App Group.");
      return;
    }
    setValidationError(undefined);
    setStep("review");
  }

  async function create() {
    setWorking(true);
    setError(undefined);
    try {
      const body = {
        name: draft.name.trim(),
        ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
        runtimeState: draft.runtimeState,
      };
      const created = await apiRequest<CreatedAppGroup>(`/api/tenants/${encodeURIComponent(tenantId)}/app-groups`, {
        method: "POST",
        body,
      });
      await onCreated(created?.id);
    } catch (cause) {
      setError(cause);
    } finally {
      setWorking(false);
    }
  }

  return <section className="rp-provision-wizard" aria-labelledby="app-group-create-title">
    <header className="rp-provision-header">
      <div className="rp-provision-icon" aria-hidden="true"><ResourceIcon name="app-group" /></div>
      <div>
        <p className="rp-eyebrow">Provision resource</p>
        <h2 id="app-group-create-title">Create AppGroup</h2>
        <p>Create a deployable application boundary. You can add applications, networking and runtime configuration after creation.</p>
      </div>
    </header>

    <ol className="rp-provision-steps" aria-label="Creation steps">
      <li data-active={step === "basics" || undefined} data-complete={step === "review" || undefined}><span>1</span><strong>Basics</strong></li>
      <li data-active={step === "review" || undefined}><span>2</span><strong>Review + create</strong></li>
    </ol>

    {validationError ? <div className="rp-form-alert" role="alert">{validationError}</div> : null}
    {error ? <ErrorState error={error} /> : null}

    {step === "basics" ? <div className="rp-provision-layout">
      <div className="rp-provision-form">
        <section className="rp-provision-section">
          <h3>App Group details</h3>
          <p>Choose a stable resource name and the runtime state that should be requested after creation.</p>

          <label className="rp-field">
            <span>Name <strong aria-hidden="true">*</strong></span>
            <input
              autoComplete="off"
              value={draft.name}
              onChange={(event) => update("name", event.target.value)}
              placeholder="shop-production"
              aria-required="true"
            />
            <small>Used in the ResourcePortal UI and API. Pick a name that identifies the workload boundary.</small>
          </label>

          <label className="rp-field">
            <span>Description</span>
            <textarea
              rows={3}
              value={draft.description}
              onChange={(event) => update("description", event.target.value)}
              placeholder="Production storefront workloads"
            />
            <small>Optional operational context for other administrators.</small>
          </label>

          <label className="rp-field">
            <span>Desired runtime state</span>
            <select value={draft.runtimeState} onChange={(event) => update("runtimeState", event.target.value as AppGroupCreateDraft["runtimeState"])}>
              <option value="Stopped">Stopped</option>
              <option value="Running">Running</option>
            </select>
            <small>Stopped is safer for staged configuration. Running requests runtime activation after creation.</small>
          </label>
        </section>
      </div>

      <aside className="rp-provision-help" aria-label="About App Groups">
        <h3>What this creates</h3>
        <p>An App Group groups applications that are configured and deployed as one operational boundary.</p>
        <dl>
          <div><dt>Applications</dt><dd>Add SingleApps after the App Group exists.</dd></div>
          <div><dt>Deployments</dt><dd>Configuration changes remain reviewable before deployment.</dd></div>
          <div><dt>Runtime</dt><dd>Start, stop and restart are managed from the resource command bar.</dd></div>
        </dl>
      </aside>
    </div> : <div className="rp-provision-review">
      <header>
        <h3>Review + create</h3>
        <p>Review the effective configuration below. Nothing has been created yet.</p>
      </header>
      <dl className="rp-review-properties">
        <div><dt>Name</dt><dd>{draft.name.trim()}</dd></div>
        <div><dt>Description</dt><dd>{draft.description.trim() || "Not set"}</dd></div>
        <div><dt>Desired runtime state</dt><dd>{draft.runtimeState}</dd></div>
      </dl>
      <div className="rp-review-callout">
        <strong>After creation</strong>
        <p>Open the App Group to add applications, attach configuration and create the first deployment.</p>
      </div>
    </div>}

    <footer className="rp-provision-actions">
      <button type="button" className="rp-button-secondary" disabled={working} onClick={step === "review" ? () => setStep("basics") : onCancel}>{step === "review" ? "Previous" : "Cancel"}</button>
      {step === "basics" ? <button type="button" className="rp-button-primary" onClick={review}>Review + create</button> : <>
        <button type="button" className="rp-button-secondary" disabled={working} onClick={onCancel}>Cancel</button>
        <button type="button" className="rp-button-primary" disabled={working} onClick={() => void create()}>{working ? "Creating…" : "Create AppGroup"}</button>
      </>}
    </footer>
  </section>;
}
