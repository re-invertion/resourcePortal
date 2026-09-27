import { useEffect, useState, type FormEvent } from "react";
import { apiRequest } from "../api/client";
import {
  Button,
  Callout,
  Card,
  DetailList,
  Field,
  HelpIcon,
  PageHeader,
  StatusBadge,
  TextInput,
  statusTone,
} from "../components/design-system";
import { toast } from "../components/toast";
import { formatDate, text, useApi } from "../hooks/use-api";

type ResourceBotPrice = {
  id: string;
  provider: string;
  model: string;
  effectiveFrom: string;
  inputCreditsPer1M: string;
  cachedInputCreditsPer1M: string;
  outputCreditsPer1M: string;
  embeddingCreditsPer1M: string;
};

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
  const prices = useApi<{ items: ResourceBotPrice[] }>("/api/platform/resource-bot/prices");
  const [enabled, setEnabled] = useState(true);
  const [generationModel, setGenerationModel] = useState("gpt-5.6-luna");
  const [embeddingModel, setEmbeddingModel] = useState("text-embedding-3-small");
  const [apiKey, setApiKey] = useState("");
  const [priceInput, setPriceInput] = useState("");
  const [priceCachedInput, setPriceCachedInput] = useState("");
  const [priceOutput, setPriceOutput] = useState("");
  const [priceEmbedding, setPriceEmbedding] = useState("");
  const [priceEffectiveFrom, setPriceEffectiveFrom] = useState(() => {
    const value = new Date(Date.now() + 60_000);
    value.setUTCSeconds(0, 0);
    return value.toISOString().slice(0, 16);
  });
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

  async function createPrice(event: FormEvent) {
    event.preventDefault();
    setWorking(true);
    try {
      const effectiveFrom = new Date(priceEffectiveFrom);
      effectiveFrom.setSeconds(0, 0);
      await apiRequest("/api/platform/resource-bot/prices", {
        method: "POST",
        body: {
          provider: "OpenAI",
          model: generationModel.trim(),
          effectiveFrom: effectiveFrom.toISOString(),
          inputCreditsPer1M: priceInput.trim(),
          cachedInputCreditsPer1M: priceCachedInput.trim(),
          outputCreditsPer1M: priceOutput.trim(),
          embeddingCreditsPer1M: priceEmbedding.trim(),
        },
      });
      await prices.reload();
      toast.success("A new ResourceBot price version was created.");
    } catch (error) {
      toast.errorFrom(error, "ResourceBot price could not be created.");
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
  const currentPrice = prices.data?.items.find(
    (price) =>
      price.provider === "OpenAI" &&
      price.model === generationModel &&
      new Date(price.effectiveFrom).getTime() <= Date.now(),
  );

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
            <TextInput
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={resourceBot.data?.apiKeyConfigured ? "Configured — enter only to rotate" : "OpenAI API key"}
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

    <Card className="mt-6 overflow-hidden">
      <div className="border-b border-[#E1E7F0] px-5 py-4">
        <h2 className="font-semibold text-[#172033]">Tenant AI pricing</h2>
        <p className="mt-1 text-xs leading-5 text-[#718096]">
          ResourceBot records provider token usage and converts it to tenant credits using an immutable, effective-dated tariff. One ResourcePortal credit remains the billing unit used by the existing tenant account.
        </p>
      </div>
      <div className="grid gap-6 p-5 lg:grid-cols-[minmax(0,.8fr)_minmax(0,1.2fr)]">
        <div>
          <h3 className="text-sm font-semibold text-[#172033]">Active tariff for {generationModel}</h3>
          {currentPrice ? <div className="mt-4">
            <DetailList columns={1} items={[
              { label: "Input / 1M tokens", value: currentPrice.inputCreditsPer1M + " credits" },
              { label: "Cached input / 1M", value: currentPrice.cachedInputCreditsPer1M + " credits" },
              { label: "Output / 1M tokens", value: currentPrice.outputCreditsPer1M + " credits" },
              { label: "Embedding / 1M tokens", value: currentPrice.embeddingCreditsPer1M + " credits" },
              { label: "Effective from", value: formatDate(currentPrice.effectiveFrom) },
            ]}/>
          </div> : <Callout tone="warning" title="No active tariff">
            ResourceBot cannot answer tenant requests with this generation model until an effective price version exists.
          </Callout>}
        </div>
        <form className="grid gap-4 sm:grid-cols-2" onSubmit={(event) => void createPrice(event)}>
          <Field label="Input credits / 1M" required>
            <TextInput value={priceInput} onChange={(event) => setPriceInput(event.target.value)} inputMode="decimal" />
          </Field>
          <Field label="Cached input credits / 1M" required>
            <TextInput value={priceCachedInput} onChange={(event) => setPriceCachedInput(event.target.value)} inputMode="decimal" />
          </Field>
          <Field label="Output credits / 1M" required>
            <TextInput value={priceOutput} onChange={(event) => setPriceOutput(event.target.value)} inputMode="decimal" />
          </Field>
          <Field label="Embedding credits / 1M" required>
            <TextInput value={priceEmbedding} onChange={(event) => setPriceEmbedding(event.target.value)} inputMode="decimal" />
          </Field>
          <Field label="Effective from" required>
            <TextInput type="datetime-local" value={priceEffectiveFrom} onChange={(event) => setPriceEffectiveFrom(event.target.value)} />
          </Field>
          <div className="sm:col-span-2">
            <Button
              type="submit"
              disabled={
                working ||
                !generationModel.trim() ||
                !priceInput.trim() ||
                !priceCachedInput.trim() ||
                !priceOutput.trim() ||
                !priceEmbedding.trim()
              }
            >
              Create price version
            </Button>
          </div>
        </form>
      </div>
    </Card>
  </main>;
}
