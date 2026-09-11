import { useMemo, useState } from "react";
import { JsonPayloadForm, type ReferenceOptions } from "./forms";

type Payload = Record<string, unknown>;

type ResourceCreationMeta = {
  resourceName: string;
  actionLabel: string;
  heading: string;
  description: string;
  outcomes: string[];
  icon: "app" | "storage" | "registry" | "network" | "identity" | "generic";
};

const configuredResources: Record<string, Omit<ResourceCreationMeta, "resourceName" | "actionLabel" | "heading"> & { resourceName: string }> = {
  tenants: {
    resourceName: "Tenant",
    description: "Create an isolated ResourcePortal workspace for applications, identities, storage, networking and billing.",
    outcomes: ["The tenant becomes a separate management boundary.", "Resources and access policies can be created inside it.", "The tenant appears in the tenant selector after creation."],
    icon: "generic",
  },
  appgroups: {
    resourceName: "AppGroup",
    description: "Create a deployable application group and define the workload boundary that ResourcePortal will manage for this tenant.",
    outcomes: ["The AppGroup is created in the current tenant.", "Applications and runtime configuration can be added next.", "A deployment can be started after the workload is configured."],
    icon: "app",
  },
  singleapps: {
    resourceName: "SingleApp",
    description: "Add an application workload to this AppGroup and prepare its runtime, image and connectivity configuration.",
    outcomes: ["The application is added to the AppGroup.", "Runtime resources and attachments can be configured next.", "The application becomes available to the AppGroup deployment workflow."],
    icon: "app",
  },
  volumes: {
    resourceName: "Volume",
    description: "Provision persistent storage for this tenant. The volume can be attached to applications that need data to survive restarts and redeployments.",
    outcomes: ["Persistent storage is provisioned for the tenant.", "The volume appears in the tenant inventory.", "Applications can attach the volume after it is created."],
    icon: "storage",
  },
  registries: {
    resourceName: "Registry",
    description: "Add a container registry that ResourcePortal can use as a source for application images.",
    outcomes: ["The registry configuration is saved for this tenant.", "Credentials remain protected and are not returned in plaintext.", "You can validate connectivity after creation."],
    icon: "registry",
  },
  domains: {
    resourceName: "Domain",
    description: "Add a domain that can be assigned to HTTP endpoints and managed through ResourcePortal routing.",
    outcomes: ["The domain is registered in the tenant.", "Validation can be run after creation.", "The domain can be assigned to an application endpoint."],
    icon: "network",
  },
  customrootdomains: {
    resourceName: "Custom root domain",
    description: "Register a custom root domain for tenant-managed application routing.",
    outcomes: ["The root domain is registered in the tenant.", "DNS validation can be performed after creation.", "Child application domains can use the validated root domain."],
    icon: "network",
  },
  httpendpoints: {
    resourceName: "HTTP endpoint",
    description: "Expose an application port through ResourcePortal HTTP routing and connect it to the selected domain configuration.",
    outcomes: ["An HTTP routing endpoint is created for the application.", "Traffic is routed to the configured container port.", "The endpoint can use a managed or custom domain according to its configuration."],
    icon: "network",
  },
  variables: {
    resourceName: "Variable",
    description: "Create a reusable application variable that can be attached to workloads without duplicating configuration.",
    outcomes: ["The variable is stored in the AppGroup configuration.", "It can be attached to one or more applications.", "The value becomes part of the workload configuration after deployment."],
    icon: "app",
  },
  configs: {
    resourceName: "Config",
    description: "Create reusable application configuration content that workloads can consume as an attachment.",
    outcomes: ["The config is stored in this AppGroup.", "Applications can attach the config next.", "The config is applied to the workload through its attachment settings."],
    icon: "app",
  },
  secrets: {
    resourceName: "Secret",
    description: "Create sensitive application configuration while keeping secret values out of normal read responses.",
    outcomes: ["The secret is stored using the platform secret workflow.", "Read views expose metadata rather than the plaintext value.", "Applications can attach the secret to their workload configuration."],
    icon: "identity",
  },
  memberships: {
    resourceName: "Membership",
    description: "Grant an existing user access to this tenant and select the roles that define what they can manage.",
    outcomes: ["The user becomes a tenant member.", "Selected roles determine the effective permissions.", "Access is available immediately after the membership is created."],
    icon: "identity",
  },
  invitations: {
    resourceName: "Invitation",
    description: "Invite a user to join this tenant with the selected access roles.",
    outcomes: ["An invitation is created for the supplied email address.", "The selected roles are applied when the invitation is accepted.", "The invitation can be resent or revoked later."],
    icon: "identity",
  },
  groups: {
    resourceName: "Group",
    description: "Create a tenant group that can be used to organize identities and access assignments.",
    outcomes: ["The group is created in the current tenant.", "Members can be associated with the group.", "The group becomes available to tenant access workflows."],
    icon: "identity",
  },
  identityproviders: {
    resourceName: "Identity provider",
    description: "Connect an external identity provider so users can authenticate through an existing organization identity system.",
    outcomes: ["The identity provider configuration is saved.", "Provider metadata can be validated and adjusted later.", "Authentication can use the provider after it is enabled and valid."],
    icon: "identity",
  },
  serviceidentities: {
    resourceName: "Service identity",
    description: "Create a non-human tenant identity for automation, integrations and service-to-service access.",
    outcomes: ["A service identity is created for this tenant.", "Its assigned roles control API permissions.", "One-time credentials are shown only when the backend returns them."],
    icon: "identity",
  },
};

const friendlyFieldLabels: Record<string, string> = {
  sizeGiB: "Size (GiB)",
  memoryMiB: "Memory (MiB)",
  cpu: "CPU",
  containerPort: "Container port",
  contactEmail: "Contact email",
  displayName: "Display name",
  registryId: "Registry",
  customRootDomainId: "Custom root domain",
  roleIds: "Roles",
  clientId: "Client ID",
  clientSecret: "Client secret",
  metadataUrl: "Metadata URL",
};

const ui = {
  workspace: "rp-create-workspace my-5 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm",
  titlebar: "rp-create-titlebar flex items-start gap-4 border-b border-slate-100 px-5 py-5 sm:px-6",
  icon: "rp-resource-icon inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-100",
  titleCopy: "min-w-0 flex-1",
  eyebrow: "rp-create-eyebrow m-0 text-[11px] font-bold uppercase tracking-[0.15em] text-slate-400",
  heading: "mt-1 text-xl font-bold tracking-[-0.025em] text-slate-950",
  description: "mb-0 mt-1 max-w-3xl text-sm leading-6 text-slate-500",
  close: "rp-create-close size-9 min-h-9 shrink-0 rounded-lg border-0 bg-transparent px-0 text-xl font-normal text-slate-400 shadow-none hover:bg-slate-100 hover:text-slate-700",
  stepper: "rp-create-stepper m-0 flex items-center gap-2 border-b border-slate-100 bg-slate-50/70 px-5 py-3 sm:px-6",
  step: "rp-create-step flex items-center gap-2 text-xs font-semibold text-slate-400 data-[active=true]:text-blue-700 data-[complete=true]:text-emerald-700",
  stepNumber: "inline-flex size-6 items-center justify-center rounded-full border border-slate-300 bg-white text-[11px] font-bold group-data-[active=true]:border-blue-600 group-data-[active=true]:bg-blue-600 group-data-[active=true]:text-white group-data-[complete=true]:border-emerald-600 group-data-[complete=true]:bg-emerald-600 group-data-[complete=true]:text-white",
  stepLine: "rp-create-step-line h-px min-w-6 flex-1 bg-slate-200",
  layout: "rp-create-layout grid lg:grid-cols-[minmax(0,1fr)_20rem]",
  main: "rp-create-main min-w-0 px-5 py-5 sm:px-6 sm:py-6 [&_.rp-structured-form]:my-0 [&_.rp-structured-form]:bg-transparent [&_.rp-structured-form]:p-0",
  intro: "rp-create-form-intro mb-4 border-b border-slate-100 pb-4",
  subheading: "text-sm font-semibold text-slate-950",
  subcopy: "mb-0 mt-1 text-xs leading-5 text-slate-500",
  guide: "rp-create-guide border-t border-slate-100 bg-slate-50/70 px-5 py-5 lg:border-l lg:border-t-0",
  guideList: "mt-4 space-y-4",
  guideItem: "grid grid-cols-[1.75rem_minmax(0,1fr)] gap-3",
  guideNumber: "inline-flex size-7 items-center justify-center rounded-full bg-white text-[11px] font-bold text-slate-500 ring-1 ring-inset ring-slate-200",
  guideCopy: "my-0 text-xs leading-5 text-slate-600",
  note: "rp-create-note mt-5 rounded-xl border border-blue-100 bg-blue-50 p-3",
  noteTitle: "text-xs font-semibold text-blue-950",
  noteCopy: "mb-0 mt-1 text-xs leading-5 text-blue-700",
  review: "rp-create-review space-y-4",
  reviewGrid: "rp-review-grid grid gap-3 sm:grid-cols-2",
  reviewField: "rp-review-field rounded-xl border border-slate-200 bg-slate-50/60 p-4",
  reviewTerm: "text-[11px] font-bold uppercase tracking-[0.08em] text-slate-400",
  reviewValue: "mt-1 break-words text-sm font-medium text-slate-900",
  muted: "rp-review-muted font-normal italic text-slate-400",
  actions: "rp-create-actions mt-5 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4",
  primary: "rp-create-primary min-h-10 rounded-lg border-blue-600 bg-blue-600 px-4 font-semibold text-white shadow-sm hover:border-blue-700 hover:bg-blue-700",
  secondary: "rp-secondary-action min-h-10 rounded-lg",
  cancel: "rp-create-cancel min-h-10 rounded-lg border-0 bg-transparent text-slate-500 shadow-none hover:bg-slate-100 hover:text-slate-900",
};

function normalizeTitle(title: string) {
  return title.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function fallbackResourceName(title: string) {
  const trimmed = title.trim();
  if (/ies$/i.test(trimmed)) return `${trimmed.slice(0, -3)}y`;
  if (/sses$/i.test(trimmed)) return trimmed.slice(0, -2);
  if (/s$/i.test(trimmed) && !/ss$/i.test(trimmed)) return trimmed.slice(0, -1);
  return trimmed || "Resource";
}

export function resourceCreationMeta(title: string): ResourceCreationMeta {
  const configured = configuredResources[normalizeTitle(title)];
  const resourceName = configured?.resourceName ?? fallbackResourceName(title);
  return {
    resourceName,
    actionLabel: `Create ${resourceName.charAt(0).toLowerCase()}${resourceName.slice(1)}`,
    heading: `Create ${resourceName}`,
    description: configured?.description ?? `Create a new ${resourceName.toLowerCase()} in ResourcePortal and make it available to the current scope.`,
    outcomes: configured?.outcomes ?? [
      `The ${resourceName.toLowerCase()} is created in the current scope.`,
      "The new resource appears in the inventory after the request succeeds.",
      "You can continue configuring or using it from its resource page.",
    ],
    icon: configured?.icon ?? "generic",
  };
}

function ResourceGlyph({ kind }: { kind: ResourceCreationMeta["icon"] }) {
  const glyphClass = "size-6 fill-none stroke-current stroke-2";
  if (kind === "storage") return <svg className={glyphClass} viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="5" rx="7" ry="3"/><path d="M5 5v6c0 1.7 3.1 3 7 3s7-1.3 7-3V5"/><path d="M5 11v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/></svg>;
  if (kind === "registry") return <svg className={glyphClass} viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/></svg>;
  if (kind === "network") return <svg className={glyphClass} viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9S14.5 18.5 12 21c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3"/></svg>;
  if (kind === "identity") return <svg className={glyphClass} viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3"/><path d="M3.5 19c.5-3.4 2.4-5 5.5-5s5 1.6 5.5 5M16 7h5M18.5 4.5v5"/></svg>;
  if (kind === "app") return <svg className={glyphClass} viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/></svg>;
  return <svg className={glyphClass} viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9h8M8 13h8M8 17h5"/></svg>;
}

function labelFor(key: string) {
  if (friendlyFieldLabels[key]) return friendlyFieldLabels[key];
  const spaced = key
    .replace(/Ids\b/g, " IDs")
    .replace(/Id\b/g, " ID")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .trim();
  return spaced.split(/\s+/).map((word, index) => {
    if (word === "ID" || word === "IDs") return word;
    const lower = word.toLowerCase();
    return index === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
  }).join(" ");
}

function ReviewValue({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === "") return <span className={ui.muted}>Not set</span>;
  if (typeof value === "boolean") return <span>{value ? "Yes" : "No"}</span>;
  if (typeof value === "number" || typeof value === "string") return <span>{String(value)}</span>;
  if (Array.isArray(value)) return value.length ? <span>{value.map((entry) => typeof entry === "object" ? JSON.stringify(entry) : String(entry)).join(", ")}</span> : <span className={ui.muted}>None</span>;
  return <code>{JSON.stringify(value)}</code>;
}

function ReviewConfiguration({ payload }: { payload: Payload }) {
  const entries = Object.entries(payload);
  return <div className={ui.review}>
    <div><h3 className={ui.subheading}>Review configuration</h3><p className={ui.subcopy}>Verify the values below before ResourcePortal applies the change.</p></div>
    <dl className={ui.reviewGrid}>
      {entries.map(([key, value]) => <div className={ui.reviewField} key={key}><dt className={ui.reviewTerm}>{labelFor(key)}</dt><dd className={ui.reviewValue}><ReviewValue value={value} /></dd></div>)}
    </dl>
  </div>;
}

export function CreateResourceWorkspace({ title, initialValue, referenceOptions, onCancel, onCreate }: {
  title: string;
  initialValue?: Payload;
  referenceOptions?: ReferenceOptions;
  onCancel: () => void;
  onCreate: (payload: Payload) => void | Promise<void>;
}) {
  const meta = useMemo(() => resourceCreationMeta(title), [title]);
  const [reviewPayload, setReviewPayload] = useState<Payload>();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();
  const reviewing = !!reviewPayload;

  async function create() {
    if (!reviewPayload) return;
    setError(undefined);
    setCreating(true);
    try { await onCreate(reviewPayload); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The resource could not be created"); }
    finally { setCreating(false); }
  }

  return <div className={ui.workspace} aria-label={meta.heading}>
    <div className={ui.titlebar}>
      <span className={ui.icon}><ResourceGlyph kind={meta.icon} /></span>
      <div className={ui.titleCopy}><p className={ui.eyebrow}>{title} / Create</p><h2 className={ui.heading}>{meta.heading}</h2><p className={ui.description}>{meta.description}</p></div>
      <button type="button" className={ui.close} onClick={onCancel} aria-label="Close create form">×</button>
    </div>

    <ol className={ui.stepper} aria-label="Creation steps">
      <li className={`${ui.step} group`} data-active={!reviewing} data-complete={reviewing}><span className={ui.stepNumber}>1</span><strong>Basics</strong></li>
      <li className={ui.stepLine} aria-hidden="true" />
      <li className={`${ui.step} group`} data-active={reviewing}><span className={ui.stepNumber}>2</span><strong>Review + create</strong></li>
    </ol>

    <div className={ui.layout}>
      <div className={ui.main}>
        {!reviewing ? <>
          <div className={ui.intro}><h3 className={ui.subheading}>Basic information</h3><p className={ui.subcopy}>Provide the settings ResourcePortal needs to create this resource. Required fields are marked by the form.</p></div>
          <JsonPayloadForm initialValue={initialValue ?? {}} referenceOptions={referenceOptions} submitLabel="Review + create" onSubmit={(payload) => setReviewPayload(payload)} />
          <button type="button" className={ui.cancel} onClick={onCancel}>Cancel</button>
        </> : <>
          <ReviewConfiguration payload={reviewPayload} />
          {error ? <p className="rp-create-error" role="alert">{error}</p> : null}
          <div className={ui.actions}>
            <button type="button" className={ui.secondary} disabled={creating} onClick={() => setReviewPayload(undefined)}>Previous</button>
            <button type="button" className={ui.primary} disabled={creating} onClick={() => void create()}>{creating ? `Creating ${meta.resourceName.toLowerCase()}…` : meta.actionLabel}</button>
            <button type="button" className={ui.cancel} disabled={creating} onClick={onCancel}>Cancel</button>
          </div>
        </>}
      </div>

      <aside className={ui.guide} aria-label="What happens next">
        <h3 className={ui.subheading}>What happens next?</h3>
        <ol className={ui.guideList}>{meta.outcomes.map((outcome, index) => <li className={ui.guideItem} key={outcome}><span className={ui.guideNumber}>{index + 1}</span><p className={ui.guideCopy}>{outcome}</p></li>)}</ol>
        <div className={ui.note}><strong className={ui.noteTitle}>Safe review</strong><p className={ui.noteCopy}>No changes are applied until you confirm the configuration in the review step.</p></div>
      </aside>
    </div>
  </div>;
}