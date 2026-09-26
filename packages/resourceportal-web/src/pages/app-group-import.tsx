import { useState, type ChangeEvent } from "react";
import { apiRequest } from "../api/client";
import { appGroupHref, tenantHref } from "../router/router";
import {
  Button,
  Callout,
  Card,
  CheckIcon,
  FileIcon,
  GridIcon,
  LinkButton,
  PageHeader,
  Stepper,
} from "../components/design-system";
import { toast } from "../components/toast";

type ManifestIssue = {
  path: string;
  code: string;
  message: string;
};

type ManifestSummary = {
  appGroupName: string;
  runtimeState: string;
  apps: number;
  variables: number;
  secrets: number;
  configs: number;
  httpEndpoints: number;
  domainAttachments: number;
  volumeAttachments: number;
  registries: string[];
  volumes: string[];
  domains: string[];
  requiredPermissions: string[];
};

type ManifestValidation = {
  valid: boolean;
  errors: ManifestIssue[];
  warnings: ManifestIssue[];
  summary?: ManifestSummary;
};

type AppliedManifest = {
  id: string;
  name: string;
  imported: boolean;
  hasPendingChanges: boolean;
};

const MAX_FILE_BYTES = 512 * 1024;

export function ImportAppGroupPage({ tenantId }: { tenantId: string }) {
  const [fileName, setFileName] = useState("");
  const [yaml, setYaml] = useState("");
  const [validation, setValidation] = useState<ManifestValidation>();
  const [validating, setValidating] = useState(false);
  const [applying, setApplying] = useState(false);

  const currentStep = validation?.valid ? 2 : yaml ? 1 : 0;

  async function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    setValidation(undefined);
    setYaml("");
    setFileName(file?.name ?? "");
    if (!file) return;

    if (!/\.ya?ml$/i.test(file.name)) {
      toast.error("Choose a .yml or .yaml file.");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      toast.error("The manifest is larger than the 512 KB limit.");
      return;
    }

    try {
      setYaml(await file.text());
    } catch {
      toast.error("The selected file could not be read.");
    }
  }

  async function validate() {
    if (!yaml) return;
    setValidating(true);
    try {
      const result = await apiRequest<ManifestValidation>(
        `/api/tenants/${encodeURIComponent(tenantId)}/app-groups/import/validate`,
        { method: "POST", body: { yaml } },
      );
      setValidation(result);
      if (result.valid) toast.success("Manifest validation passed.");
    } catch (cause) {
      setValidation(undefined);
      toast.errorFrom(cause, "The manifest could not be validated.");
    } finally {
      setValidating(false);
    }
  }

  async function apply() {
    if (!yaml || !validation?.valid) return;
    setApplying(true);
    try {
      const result = await apiRequest<AppliedManifest>(
        `/api/tenants/${encodeURIComponent(tenantId)}/app-groups/import/apply`,
        { method: "POST", body: { yaml } },
      );
      window.location.assign(appGroupHref(tenantId, result.id));
    } catch (cause) {
      toast.errorFrom(cause, "The App Group could not be imported.");
      setApplying(false);
    }
  }

  const summary = validation?.summary;

  return <main>
    <PageHeader
      eyebrow="Applications"
      title="Import App Group from YAML"
      description="Select a ResourcePortal manifest, validate it against this tenant, then create the App Group and its configured resources."
      breadcrumbs={<>
        <a href={tenantHref(tenantId, "applications")} className="hover:underline">Applications</a>
        <span className="mx-1.5">/</span>
        Import YAML
      </>}
      actions={<LinkButton href={`${tenantHref(tenantId, "help")}#app-group-yaml`} variant="ghost">YAML format help</LinkButton>}
    />

    <Card className="mx-auto max-w-4xl overflow-hidden">
      <div className="border-b border-[#E1E7F0] p-5">
        <Stepper steps={["Select file", "Validate", "Create"]} current={currentStep} />
      </div>

      <div className="space-y-5 p-5 sm:p-6">
        <div>
          <h2 className="text-lg font-semibold text-[#172033]">Manifest file</h2>
          <p className="mt-1 text-sm leading-6 text-[#5B6678]">
            ResourcePortal validates the YAML structure, permissions, tenant quota and referenced resources before anything is created.
          </p>
        </div>

        <label className="block rounded-xl border border-dashed border-[#B9C7D8] bg-[#F8FAFD] p-6 text-center hover:border-[#7DA6D9]">
          <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg bg-[#E7F1FF] text-[#1769E0]"><FileIcon /></span>
          <span className="mt-3 block text-sm font-semibold text-[#172033]">{fileName || "Choose a YAML manifest"}</span>
          <span className="mt-1 block text-xs text-[#718096]">.yml or .yaml · maximum 512 KB</span>
          <input
            aria-label="YAML manifest file"
            className="mt-4 block w-full text-sm text-[#526070] file:mr-3 file:rounded-md file:border file:border-[#C7D1DF] file:bg-white file:px-3 file:py-2 file:text-sm file:font-medium file:text-[#172033]"
            type="file"
            accept=".yml,.yaml,text/yaml,application/yaml"
            onChange={(event) => void chooseFile(event)}
          />
        </label>

        {yaml && !validation ? <Callout title="File loaded">
          <strong>{fileName}</strong> is ready to validate. Validation does not create or modify resources.
        </Callout> : null}


        {validation && !validation.valid ? <Callout tone="danger" title="Manifest cannot be applied">
          <p>Fix the following validation errors and select the updated file again.</p>
          <ul className="mt-2 space-y-1">
            {validation.errors.map((issue, index) => <li key={`${issue.path}-${issue.code}-${index}`}>
              <code>{issue.path}</code>: {issue.message}
            </li>)}
          </ul>
        </Callout> : null}

        {validation?.warnings?.length ? <Callout tone="warning" title="Review before creating">
          <ul className="space-y-1">
            {validation.warnings.map((issue, index) => <li key={`${issue.path}-${issue.code}-${index}`}>
              {issue.message}
            </li>)}
          </ul>
        </Callout> : null}

        {validation?.valid && summary ? <div className="space-y-4">
          <Callout tone="success" title="Manifest is valid">
            ResourcePortal can create this App Group with the current tenant state and your permissions.
          </Callout>
          <div className="rounded-xl border border-[#D7E0EC] bg-white p-5">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#E8F5EE] text-[#137A4A]"><CheckIcon /></span>
              <div>
                <h3 className="font-semibold text-[#172033]">{summary.appGroupName}</h3>
                <p className="text-xs text-[#718096]">Initial App Group state: {summary.runtimeState}</p>
              </div>
            </div>
            <dl className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Summary label="Applications" value={summary.apps} />
              <Summary label="Variables" value={summary.variables} />
              <Summary label="Secrets" value={summary.secrets} />
              <Summary label="Configs" value={summary.configs} />
              <Summary label="HTTP endpoints" value={summary.httpEndpoints} />
              <Summary label="Domains to attach" value={summary.domainAttachments} />
              <Summary label="Volume mounts" value={summary.volumeAttachments} />
              <Summary label="Permissions checked" value={summary.requiredPermissions.length} />
            </dl>
            {(summary.registries.length || summary.volumes.length || summary.domains.length) ? <div className="mt-5 border-t border-[#E1E7F0] pt-4 text-xs leading-5 text-[#5B6678]">
              {summary.registries.length ? <p><strong>Registries:</strong> {summary.registries.join(", ")}</p> : null}
              {summary.volumes.length ? <p><strong>Volumes:</strong> {summary.volumes.join(", ")}</p> : null}
              {summary.domains.length ? <p><strong>Domains:</strong> {summary.domains.join(", ")}</p> : null}
            </div> : null}
          </div>
          <Callout title="Creation does not deploy runtime changes">
            The App Group and its desired configuration are created atomically. If the manifest contains applications, open the imported App Group and use <strong>Deploy changes</strong> after reviewing it.
          </Callout>
        </div> : null}
      </div>

      <footer className="flex flex-col-reverse justify-between gap-3 border-t border-[#E1E7F0] bg-[#F8FAFD] p-4 sm:flex-row">
        <a href={tenantHref(tenantId, "applications")} className="inline-flex h-10 items-center justify-center rounded-md px-3 text-sm font-medium text-[#526070] hover:bg-[#EEF3F9]">Cancel</a>
        <div className="flex justify-end gap-2">
          {yaml ? <Button disabled={validating || applying} onClick={() => void validate()}>
            {validating ? "Validating…" : validation ? "Validate again" : "Validate manifest"}
          </Button> : null}
          {validation?.valid ? <Button variant="primary" disabled={applying || validating} onClick={() => void apply()}>
            <GridIcon size={16} />{applying ? "Creating…" : "Create App Group"}
          </Button> : null}
        </div>
      </footer>
    </Card>
  </main>;
}

function Summary({ label, value }: { label: string; value: number }) {
  return <div className="rounded-lg bg-[#F8FAFD] px-3 py-2">
    <dt className="text-[11px] text-[#718096]">{label}</dt>
    <dd className="mt-0.5 text-base font-semibold text-[#172033]">{value}</dd>
  </div>;
}
