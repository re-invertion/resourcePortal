import { useEffect, useMemo, useState, type FormEvent } from "react";
import { apiRequest } from "../api/client";
import {
  BillingUsageCharts,
  billingUsageBucket,
  billingUsageRangeFrom,
  type BillingUsageRange,
} from "../components/billing-usage-charts";
import {
  BillingIcon,
  Button,
  Callout,
  Card,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  MetricCard,
  NumberInput,
  PageHeader,
  Select,
  StatusBadge,
  Tabs,
  TextInput,
  UsersIcon,
  statusTone,
} from "../components/design-system";
import { formatDate, idOf, items, text, useApi } from "../hooks/use-api";
import { platformHref } from "../router/router";
import { toast } from "../components/toast";

type Row = Record<string, unknown>;
type BillingSection = "overview" | "pricing" | "vouchers";

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

function valueOf(row: Row | undefined, ...keys: string[]) {
  if (!row) return undefined;
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function numberText(value: unknown, fallback = "—") {
  if (typeof value === "number") return String(value);
  return text(value, fallback);
}

function readableError(error: unknown) {
  return error instanceof Error ? error.message : "The request could not be completed.";
}

function SectionTitle({
  eyebrow,
  title,
  description,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
}) {
  return (
    <div className="border-b border-[#E1E7F0] px-5 py-4">
      {eyebrow ? (
        <p className="text-[11px] font-semibold uppercase tracking-[.06em] text-[#1769E0]">
          {eyebrow}
        </p>
      ) : null}
      <h2 className="mt-0.5 text-lg font-semibold text-[#172033]">{title}</h2>
      {description ? <p className="mt-1 text-xs text-[#718096]">{description}</p> : null}
    </div>
  );
}

function BillingTabs({ active }: { active: BillingSection }) {
  return (
    <Tabs
      label="Billing sections"
      items={[
        { label: "Overview", href: platformHref("billing"), active: active === "overview" },
        {
          label: "Pricing",
          href: platformHref("billing", "pricing"),
          active: active === "pricing",
        },
        {
          label: "Vouchers",
          href: platformHref("billing", "vouchers"),
          active: active === "vouchers",
        },
      ]}
    />
  );
}

function defaultEffectiveFrom() {
  const value = new Date(Date.now() + 60_000);
  value.setSeconds(0, 0);
  return value.toISOString().slice(0, 16);
}

export function PlatformBillingPage({
  activeSection = "overview",
}: {
  activeSection?: BillingSection;
}) {
  const tenants = useApi<unknown>("/api/platform/tenants", []);
  const prices = useApi<unknown>("/api/platform/billing/price-lists", []);
  const vouchers = useApi<unknown>("/api/platform/billing/vouchers", []);
  const aiPrices = useApi<{ items: ResourceBotPrice[] }>("/api/platform/resource-bot/prices");
  const resourceBot = useApi<Row>("/api/platform/resource-bot");

  const tenantRows = items<Row>(tenants.data);
  const priceRows = items<Row>(prices.data);
  const voucherRows = items<Row>(vouchers.data);
  const aiPriceRows = aiPrices.data?.items ?? [];

  const [tenantId, setTenantId] = useState("");
  const [usageRange, setUsageRange] = useState<BillingUsageRange>("7d");
  const [voucherOpen, setVoucherOpen] = useState(false);
  const [credits, setCredits] = useState("100");
  const [voucherExpiresAt, setVoucherExpiresAt] = useState("");
  const [createdVoucher, setCreatedVoucher] = useState<Row>();
  const [resourcePrice, setResourcePrice] = useState({
    cpu: "",
    memory: "",
    storage: "",
    gpu: "",
    effectiveFrom: defaultEffectiveFrom(),
  });
  const [aiPrice, setAiPrice] = useState({
    provider: "OpenAI",
    model: "gpt-5.6-luna",
    input: "",
    cachedInput: "",
    output: "",
    embedding: "",
    effectiveFrom: defaultEffectiveFrom(),
  });
  const [working, setWorking] = useState<string>();

  useEffect(() => {
    const provider = text(resourceBot.data?.provider, "OpenAI");
    const model = text(resourceBot.data?.generationModel, "gpt-5.6-luna");
    setAiPrice((current) => ({
      ...current,
      provider,
      model,
    }));
  }, [resourceBot.data]);

  useEffect(() => {
    const current = items<Row>(prices.data)[0];
    if (!current) return;
    setResourcePrice((value) => ({
      ...value,
      cpu: numberText(current.cpuCreditsPerVcpuHour, value.cpu),
      memory: numberText(current.memoryCreditsPerGbHour, value.memory),
      storage: numberText(current.storageCreditsPerGbHour, value.storage),
      gpu: numberText(current.gpuCreditsPerGpuHour, value.gpu),
    }));
  }, [prices.data]);

  useEffect(() => {
    const current = aiPrices.data?.items?.[0];
    if (!current) return;
    setAiPrice((value) => ({
      ...value,
      provider: current.provider || value.provider,
      model: current.model || value.model,
      input: current.inputCreditsPer1M,
      cachedInput: current.cachedInputCreditsPer1M,
      output: current.outputCreditsPer1M,
      embedding: current.embeddingCreditsPer1M,
    }));
  }, [aiPrices.data]);

  const usagePath = useMemo(() => {
    if (!tenantId) return undefined;
    const params = new URLSearchParams({
      tenantId,
      bucket: billingUsageBucket(usageRange),
    });
    const from = billingUsageRangeFrom(usageRange);
    if (from) params.set("from", from);
    return `/api/platform/billing/usage-series?${params.toString()}`;
  }, [tenantId, usageRange]);
  const usage = useApi<unknown>(usagePath, []);

  async function createVoucher(event: FormEvent) {
    event.preventDefault();
    setWorking("voucher");
    try {
      const created = await apiRequest<Row>("/api/platform/billing/vouchers", {
        method: "POST",
        body: {
          valueCredits: credits,
          expiresAt: voucherExpiresAt
            ? new Date(voucherExpiresAt).toISOString()
            : undefined,
        },
      });
      setCreatedVoucher(created);
      await vouchers.reload();
      toast.success("Voucher created and ready to share.");
    } catch (error) {
      toast.error(`Voucher creation failed: ${readableError(error)}`);
    } finally {
      setWorking(undefined);
    }
  }

  async function copyVoucherCode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      toast.success("Voucher code copied.");
    } catch {
      toast.warning("Copy failed. Select the voucher code manually.");
    }
  }

  async function createCombinedPricing(event: FormEvent) {
    event.preventDefault();
    setWorking("pricing");
    try {
      const effectiveFrom = new Date(resourcePrice.effectiveFrom);
      effectiveFrom.setSeconds(0, 0);
      const effectiveFromIso = effectiveFrom.toISOString();
      await Promise.all([
        apiRequest("/api/platform/billing/price-lists", {
          method: "POST",
          body: {
            effectiveFrom: effectiveFromIso,
            cpuCreditsPerVcpuHour: resourcePrice.cpu.trim(),
            memoryCreditsPerGbHour: resourcePrice.memory.trim(),
            storageCreditsPerGbHour: resourcePrice.storage.trim(),
            gpuCreditsPerGpuHour: resourcePrice.gpu.trim(),
          },
        }),
        apiRequest("/api/platform/resource-bot/prices", {
          method: "POST",
          body: {
            provider: aiPrice.provider.trim(),
            model: aiPrice.model.trim(),
            effectiveFrom: effectiveFromIso,
            inputCreditsPer1M: aiPrice.input.trim(),
            cachedInputCreditsPer1M: aiPrice.cachedInput.trim(),
            outputCreditsPer1M: aiPrice.output.trim(),
            embeddingCreditsPer1M: aiPrice.embedding.trim(),
          },
        }),
      ]);
      await Promise.all([prices.reload(), aiPrices.reload()]);
      setResourcePrice((current) => ({
        ...current,
        effectiveFrom: defaultEffectiveFrom(),
      }));
      toast.success("Platform pricing version created for resources and AI.");
    } catch (error) {
      toast.error(`Platform pricing could not be created: ${readableError(error)}`);
    } finally {
      setWorking(undefined);
    }
  }

  const headerAction = (
    <Button
      variant="primary"
      onClick={() => {
        setCreatedVoucher(undefined);
        setCredits("100");
        setVoucherExpiresAt("");
        setVoucherOpen(true);
      }}
    >
      Create voucher
    </Button>
  );

  return (
    <main>
      <PageHeader
        eyebrow="Platform Admin"
        title="Billing"
        description="Platform usage visibility, resource pricing, AI pricing and vouchers."
        actions={headerAction}
      />
      <BillingTabs active={activeSection} />

      {activeSection === "overview" ? (
        <>
          <section className="grid gap-4 sm:grid-cols-3">
            <MetricCard label="Price lists" value={String(priceRows.length)} icon={<BillingIcon />} loading={prices.loading} error={prices.error} />
            <MetricCard label="Vouchers" value={String(voucherRows.length)} icon={<BillingIcon />} loading={vouchers.loading} error={vouchers.error} />
            <MetricCard label="Tenants" value={String(tenantRows.length)} icon={<UsersIcon />} loading={tenants.loading} error={tenants.error} />
          </section>

          <Card className="mt-6 overflow-hidden">
            <SectionTitle
              eyebrow="Tenant isolation"
              title="Usage by tenant"
              description="Platform Admin can inspect aggregate usage charts only. Tenant billing state, quota, transactions, applications and activity remain tenant-private."
            />
            <div className="p-5">
              <Field label="Tenant">
                <Select value={tenantId} onChange={(event) => setTenantId(event.target.value)}>
                  <option value="">Select tenant</option>
                  {tenantRows.map((row) => (
                    <option key={idOf(row)} value={idOf(row)}>
                      {text(valueOf(row, "displayName", "name"), "Unnamed tenant")}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            {tenantId ? (
              <BillingUsageCharts
                rows={items<Row>(usage.data)}
                loading={usage.loading}
                error={usage.error}
                range={usageRange}
                onRangeChange={setUsageRange}
              />
            ) : (
              <div className="px-5 pb-5">
                <EmptyState title="Select a tenant" description="Only aggregate usage charts are exposed to Platform Admin." />
              </div>
            )}
          </Card>
        </>
      ) : null}
      {activeSection === "pricing" ? (
        <Card className="overflow-hidden">
          <SectionTitle
            eyebrow="Pricing"
            title="Platform pricing"
            description="One shared pricing workspace for compute, storage, GPU and AI token rates."
          />
          <form onSubmit={(event) => void createCombinedPricing(event)}>
            <section aria-labelledby="compute-storage-pricing-heading">
              <div className="px-5 py-4">
                <h3 id="compute-storage-pricing-heading" className="text-sm font-semibold text-[#172033]">Compute & storage</h3>
                <p className="mt-1 text-xs text-[#718096]">Immutable, effective-dated tenant rates for CPU, memory, storage and GPU.</p>
              </div>
              <DataTable
                embedded
                className="rounded-none border-0"
                loading={prices.loading}
                columns={[
                  { key: "version", label: "Version" },
                  { key: "effective", label: "Effective" },
                  { key: "cpu", label: "CPU / vCPU h" },
                  { key: "memory", label: "Memory / GB h" },
                  { key: "storage", label: "Storage / GB h" },
                  { key: "gpu", label: "GPU / h" },
                ]}
                rows={priceRows.map((row, index) => ({
                  key: idOf(row) || String(index),
                  cells: {
                    version: row.version !== undefined ? `v${String(row.version)}` : "—",
                    effective: formatDate(row.effectiveFrom),
                    cpu: numberText(row.cpuCreditsPerVcpuHour),
                    memory: numberText(row.memoryCreditsPerGbHour),
                    storage: numberText(row.storageCreditsPerGbHour),
                    gpu: numberText(row.gpuCreditsPerGpuHour),
                  },
                }))}
                empty={<EmptyState title="No resource price lists" />}
              />
              <div className="grid gap-4 border-t border-[#E1E7F0] bg-[#F8FAFD] p-5 sm:grid-cols-2 xl:grid-cols-5">
                <Field label="CPU credits / vCPU h" required>
                  <TextInput aria-label="CPU credits / vCPU h" inputMode="decimal" value={resourcePrice.cpu} onChange={(event) => setResourcePrice({ ...resourcePrice, cpu: event.target.value })} />
                </Field>
                <Field label="Memory credits / GB h" required>
                  <TextInput aria-label="Memory credits / GB h" inputMode="decimal" value={resourcePrice.memory} onChange={(event) => setResourcePrice({ ...resourcePrice, memory: event.target.value })} />
                </Field>
                <Field label="Storage credits / GB h" required>
                  <TextInput aria-label="Storage credits / GB h" inputMode="decimal" value={resourcePrice.storage} onChange={(event) => setResourcePrice({ ...resourcePrice, storage: event.target.value })} />
                </Field>
                <Field label="GPU credits / GPU h" required>
                  <TextInput aria-label="GPU credits / GPU h" inputMode="decimal" value={resourcePrice.gpu} onChange={(event) => setResourcePrice({ ...resourcePrice, gpu: event.target.value })} />
                </Field>
                <Field label="Effective from" required>
                  <TextInput aria-label="Effective from" type="datetime-local" value={resourcePrice.effectiveFrom} onChange={(event) => setResourcePrice({ ...resourcePrice, effectiveFrom: event.target.value })} />
                </Field>
              </div>
            </section>

            <section className="border-t border-[#E1E7F0]" aria-labelledby="ai-pricing-heading">
              <div className="px-5 py-4">
                <h3 id="ai-pricing-heading" className="text-sm font-semibold text-[#172033]">AI & ResourceBot</h3>
                <p className="mt-1 text-xs text-[#718096]">ResourceBot token rates are saved together with compute and storage using the same effective time. Current values are prefilled for editing.</p>
              </div>
              {aiPrices.error ? (
                <div className="p-5">
                  <Callout tone="danger" title="AI pricing unavailable">{readableError(aiPrices.error)}</Callout>
                </div>
              ) : (
                <DataTable
                  embedded
                  className="rounded-none border-0"
                  loading={aiPrices.loading}
                  columns={[
                    { key: "model", label: "Provider / model" },
                    { key: "effective", label: "Effective" },
                    { key: "input", label: "Input / 1M" },
                    { key: "cached", label: "Cached / 1M" },
                    { key: "output", label: "Output / 1M" },
                    { key: "embedding", label: "Embedding / 1M" },
                  ]}
                  rows={aiPriceRows.map((row) => ({
                    key: row.id,
                    cells: {
                      model: `${row.provider} / ${row.model}`,
                      effective: formatDate(row.effectiveFrom),
                      input: row.inputCreditsPer1M,
                      cached: row.cachedInputCreditsPer1M,
                      output: row.outputCreditsPer1M,
                      embedding: row.embeddingCreditsPer1M,
                    },
                  }))}
                  empty={<EmptyState title="No AI price versions" />}
                />
              )}
              <div className="grid gap-4 border-t border-[#E1E7F0] bg-[#F8FAFD] p-5 sm:grid-cols-2 xl:grid-cols-4">
                <Field label="Provider" required>
                  <TextInput aria-label="Provider" value={aiPrice.provider} onChange={(event) => setAiPrice({ ...aiPrice, provider: event.target.value })} />
                </Field>
                <Field label="Model" required>
                  <TextInput aria-label="Model" value={aiPrice.model} onChange={(event) => setAiPrice({ ...aiPrice, model: event.target.value })} />
                </Field>
                <Field label="Input credits / 1M" required>
                  <TextInput aria-label="Input credits / 1M" inputMode="decimal" value={aiPrice.input} onChange={(event) => setAiPrice({ ...aiPrice, input: event.target.value })} />
                </Field>
                <Field label="Cached input credits / 1M" required>
                  <TextInput aria-label="Cached input credits / 1M" inputMode="decimal" value={aiPrice.cachedInput} onChange={(event) => setAiPrice({ ...aiPrice, cachedInput: event.target.value })} />
                </Field>
                <Field label="Output credits / 1M" required>
                  <TextInput aria-label="Output credits / 1M" inputMode="decimal" value={aiPrice.output} onChange={(event) => setAiPrice({ ...aiPrice, output: event.target.value })} />
                </Field>
                <Field label="Embedding credits / 1M" required>
                  <TextInput aria-label="Embedding credits / 1M" inputMode="decimal" value={aiPrice.embedding} onChange={(event) => setAiPrice({ ...aiPrice, embedding: event.target.value })} />
                </Field>
              </div>
            </section>

            <div className="flex justify-end border-t border-[#E1E7F0] bg-white p-5">
              <Button
                type="submit"
                variant="primary"
                disabled={
                  working === "pricing" ||
                  !resourcePrice.cpu.trim() ||
                  !resourcePrice.memory.trim() ||
                  !resourcePrice.storage.trim() ||
                  !resourcePrice.gpu.trim() ||
                  !aiPrice.provider.trim() ||
                  !aiPrice.model.trim() ||
                  !aiPrice.input.trim() ||
                  !aiPrice.cachedInput.trim() ||
                  !aiPrice.output.trim() ||
                  !aiPrice.embedding.trim()
                }
              >
                {working === "pricing" ? "Creating…" : "Create resource + AI pricing version"}
              </Button>
            </div>
          </form>
        </Card>
      ) : null}

      {activeSection === "vouchers" ? (
        <Card className="overflow-hidden">
          <SectionTitle
            eyebrow="Credits"
            title="Vouchers"
            description="Voucher codes are encrypted at rest and visible only to Platform Admin."
          />
          {vouchers.error ? (
            <div className="p-5">
              <Callout tone="danger" title="Vouchers unavailable">
                {readableError(vouchers.error)}
              </Callout>
            </div>
          ) : (
            <DataTable
              embedded
              className="rounded-none border-0"
              loading={vouchers.loading}
              columns={[
                { key: "code", label: "Code" },
                { key: "credits", label: "Credits" },
                { key: "status", label: "Status" },
                { key: "expires", label: "Expires" },
              ]}
              rows={voucherRows.map((row, index) => {
                const code = text(row.code, "");
                return {
                  key: idOf(row) || String(index),
                  cells: {
                    code: code ? (
                      <div className="flex min-w-[260px] items-center gap-2">
                        <code className="select-all rounded bg-[#F4F7FB] px-2 py-1 text-[11px] text-[#172033]">
                          {code}
                        </code>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void copyVoucherCode(code)}
                        >
                          Copy
                        </Button>
                      </div>
                    ) : (
                      <span className="text-xs text-[#718096]">Legacy code unavailable</span>
                    ),
                    credits: numberText(valueOf(row, "valueCredits", "credits")),
                    status: (
                      <StatusBadge tone={statusTone(valueOf(row, "status", "redeemedAt"))}>
                        {row.redeemedAt
                          ? "Redeemed"
                          : text(valueOf(row, "status"), "Available")}
                      </StatusBadge>
                    ),
                    expires: row.expiresAt ? formatDate(row.expiresAt) : "Never",
                  },
                };
              })}
              empty={<EmptyState title="No vouchers" />}
            />
          )}
        </Card>
      ) : null}

      <Dialog
        open={voucherOpen}
        onClose={() => setVoucherOpen(false)}
        title={createdVoucher ? "Voucher created" : "Create voucher"}
        description={
          createdVoucher
            ? "The code is ready to share and remains available in the admin voucher list."
            : "Create a credit voucher and optionally set an expiration date."
        }
        actions={
          createdVoucher ? (
            <Button variant="primary" onClick={() => setVoucherOpen(false)}>
              Done
            </Button>
          ) : (
            <>
              <Button onClick={() => setVoucherOpen(false)}>Cancel</Button>
              <Button
                variant="primary"
                type="submit"
                form="voucher-form"
                disabled={!credits || Number(credits) <= 0 || working === "voucher"}
              >
                Create voucher
              </Button>
            </>
          )
        }
      >
        {createdVoucher ? (
          <div className="space-y-4">
            <Callout tone="success" title="Voucher is active">
              Copy the code below. It remains restricted to Platform Admin.
            </Callout>
            <div className="rounded-lg border border-[#D7E0EC] bg-[#F8FAFD] p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-[#718096]">
                Voucher code
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <code className="select-all break-all text-sm font-semibold text-[#172033]">
                  {text(createdVoucher.code, "Code unavailable")}
                </code>
                {createdVoucher.code ? (
                  <Button
                    size="sm"
                    onClick={() => void copyVoucherCode(text(createdVoucher.code))}
                  >
                    Copy code
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
        ) : (
          <form
            id="voucher-form"
            className="space-y-4"
            onSubmit={(event) => void createVoucher(event)}
          >
            <Field
              label="Credit value"
              required
              hint="Credits granted once when the voucher is redeemed."
            >
              <NumberInput
                aria-label="Credit value"
                min="1"
                value={credits}
                onChange={(event) => setCredits(event.target.value)}
              />
            </Field>
            <Field
              label="Expiration date"
              hint="Optional. Leave blank for a voucher that does not expire."
            >
              <TextInput
                aria-label="Expiration date"
                type="datetime-local"
                value={voucherExpiresAt}
                onChange={(event) => setVoucherExpiresAt(event.target.value)}
              />
            </Field>
          </form>
        )}
      </Dialog>

    </main>
  );
}