import { useEffect, useState, type FormEvent } from "react";
import { apiRequest } from "../api/client";
import {
  Button,
  Callout,
  Card,
  DetailList,
  Field,
  HelpIcon,
  LinkButton,
  PageHeader,
  StatusBadge,
  TextInput,
  statusTone,
} from "../components/design-system";
import { toast } from "../components/toast";
import { StoredSecretInput } from "../components/stored-secret-input";
import { formatDate, text, useApi } from "../hooks/use-api";
import { platformHref } from "../router/router";

type ResourceBotState = {
  provider?: string;
  enabled?: boolean;
  configured?: boolean;
  available?: boolean;
  apiKeyConfigured?: boolean;
  generationModel?: string;
  embeddingModel?: string;
  lastValidatedAt?: string | null;
  lastError?: string | null;
  updatedAt?: string | null;
};

export function PlatformResourceBotPage() {
  const resourceBot = useApi<ResourceBotState>("/api/platform/resource-bot");
  const [enabled, setEnabled] = useState(true);
  const [generationModel, setGenerationModel] = useState("gpt-5.6-luna");
  const [embeddingModel, setEmbeddingModel] = useState("text-embedding-3-small");
  const [apiKey, setApiKey] = useState("");
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (!resourceBot.data) return;
    setEnabled(resourceBot.data.enabled !== false);
    setGenerationModel(text(resourceBot.data.generationModel, "gpt-5.6-luna"));
    setEmbeddingModel(text(resourceBot.data.embeddingModel, "text-embedding-3-small"));
    setApiKey("");
  }, [resourceBot.data]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setWorking(true);
    try {
      await apiRequest("/api/platform/resource-bot", {
        method: "PATCH",
        body: {
          enabled,
          provider: "OpenAI",
          generationModel: generationModel.trim(),
          embeddingModel: embeddingModel.trim(),
          apiKey: apiKey.trim() || undefined,
        },
      });
      await resourceBot.reload();
      setApiKey("");
      toast.success(
        enabled
          ? "ResourceBot provider configuration saved and validated."
          : "ResourceBot configuration saved. Global access is disabled.",
      );
    } catch (error) {
      toast.errorFrom(error, "ResourceBot configuration failed.");
    } finally {
      setWorking(false);
    }
  }

  async function validate() {
    setWorking(true);
    try {
      await apiRequest("/api/platform/resource-bot/validate", { method: "POST" });
      await resourceBot.reload();
      toast.success("ResourceBot provider credential and configured models were validated.");
    } catch (error) {
      toast.errorFrom(error, "ResourceBot validation failed.");
    } finally {
      setWorking(false);
    }
  }

  const stateLabel = resourceBot.data?.available
    ? "Ready"
    : resourceBot.data?.enabled
      ? "Unavailable"
      : "Disabled";

  return <main>
    <PageHeader
      eyebrow="Platform Admin"
      title="AI & ResourceBot"
      description="Configure the platform-owned AI provider used by the built-in tenant ResourceBot assistant."
    />

    {resourceBot.error ? <Callout tone="danger" title="ResourceBot configuration unavailable">
      {resourceBot.error instanceof Error ? resourceBot.error.message : "The ResourceBot platform API could not be loaded."}
    </Callout> : null}

    <div className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,.85fr)]">
      <Card className="overflow-hidden">
        <div className="border-b border-[#E1E7F0] px-5 py-4">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#E7F1FF] text-[#1769E0]"><HelpIcon size={19}/></span>
            <div>
              <h2 className="font-semibold text-[#172033]">OpenAI provider</h2>
              <p className="mt-0.5 text-xs text-[#718096]">The API key is encrypted at rest and is never returned to tenant users or the browser.</p>
            </div>
          </div>
        </div>

        <form className="space-y-5 p-5" onSubmit={(event) => void save(event)}>
          <label className="flex items-start gap-3 rounded-lg border border-[#D7E0EC] p-4">
            <input
              className="mt-1"
              aria-label="Enable ResourceBot globally"
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            <span>
              <strong className="block text-sm text-[#172033]">Enable ResourceBot globally</strong>
              <span className="mt-1 block text-xs leading-5 text-[#718096]">
                This is the platform kill switch. Individual tenants can still disable ResourceBot in Tenant Settings.
              </span>
            </span>
          </label>

          <Field label="Generation model" required hint="Model used to answer grounded Help questions.">
            <TextInput
              value={generationModel}
              onChange={(event) => setGenerationModel(event.target.value)}
              placeholder="gpt-5.6-luna"
              autoComplete="off"
            />
          </Field>

          <Field label="Embedding model" required hint="Model used to index and retrieve ResourcePortal Help sections.">
            <TextInput
              value={embeddingModel}
              onChange={(event) => setEmbeddingModel(event.target.value)}
              placeholder="text-embedding-3-small"
              autoComplete="off"
            />
          </Field>

          <Field
            label="OpenAI API key"
            hint={resourceBot.data?.apiKeyConfigured
              ? "A key is already configured. Leave blank to keep it."
              : "Required before ResourceBot can become available."}
          >
            <StoredSecretInput
              aria-label="OpenAI API key"
              configured={resourceBot.data?.apiKeyConfigured === true}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="OpenAI API key"
              autoComplete="new-password"
            />
          </Field>

          <Callout title="Platform credential, tenant billing">
            ResourcePortal owns the provider credential. ResourceBot requests are still metered and charged to the tenant that generated the request; the key is never exposed to tenants.
          </Callout>

          <div className="flex flex-wrap gap-2">
            <Button variant="primary" type="submit" disabled={working}>{working ? "Saving…" : "Save configuration"}</Button>
            <Button type="button" disabled={working || !resourceBot.data?.configured} onClick={() => void validate()}>Validate provider</Button>
          </div>
        </form>
      </Card>

      <div className="space-y-6">
        <Card className="p-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="font-semibold text-[#172033]">ResourceBot state</h2>
            <StatusBadge tone={statusTone(stateLabel)}>{stateLabel}</StatusBadge>
          </div>
          <DetailList columns={1} items={[
            { label: "Provider", value: text(resourceBot.data?.provider, "OpenAI") },
            { label: "Generation model", value: text(resourceBot.data?.generationModel, "—") },
            { label: "Embedding model", value: text(resourceBot.data?.embeddingModel, "—") },
            { label: "API key", value: resourceBot.data?.apiKeyConfigured ? "Configured" : "Not configured" },
            { label: "Last validated", value: formatDate(resourceBot.data?.lastValidatedAt) },
          ]}/>
        </Card>

        {resourceBot.data?.lastError
          ? <Callout tone="danger" title="Last provider error">{resourceBot.data.lastError}</Callout>
          : <Callout tone="success" title="Tenant isolation preserved">
              ResourceBot v1 receives only Help excerpts and bounded conversation text. It is not granted tools or live access to tenant resources.
            </Callout>}
      </div>
    </div>

    <Card className="mt-6 p-5">
      <h2 className="font-semibold text-[#172033]">ResourceBot pricing</h2>
      <p className="mt-1 max-w-3xl text-sm leading-5 text-[#5B6678]">
        Token rates are managed centrally with the other platform tariffs in Billing → Pricing.
        Provider credentials and model selection remain on this page.
      </p>
      <LinkButton className="mt-4" href={platformHref("billing", "pricing")}>
        Open Billing pricing
      </LinkButton>
    </Card>
  </main>;
}
