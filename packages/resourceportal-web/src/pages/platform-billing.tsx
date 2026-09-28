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
  DetailList,
  Dialog,
  EmptyState,
  Field,
  LinkButton,
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
import { platformHref, tenantHref } from "../router/router";
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
  const tenants = useApi<unknown>("/api/tenants", []);
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
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjustment, setAdjustment] = useState({
    amountCredits: "",
    reason: "",
    reference: "",
  });
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

  const selectedTenant = tenantRows.find((row) => idOf(row) === tenantId);
  const tenantRoot = tenantId ? `/api/tenants/${encodeURIComponent(tenantId)}` : undefined;
  const billing = useApi<Row>(tenantRoot ? `${tenantRoot}/billing` : undefined);
  const quota = useApi<Row>(tenantRoot ? `${tenantRoot}/quota` : undefined);
  const transactions = useApi<unknown>(
    tenantRoot ? `${tenantRoot}/billing/transactions?limit=20` : undefined,
    [],
  );
  const usagePath = useMemo(() => {
    if (!tenantRoot) return undefined;
    const params = new URLSearchParams({ bucket: billingUsageBucket(usageRange) });
    const from = billingUsageRangeFrom(usageRange);
    if (from) params.set("from", from);
    return `${tenantRoot}/billing/usage-series?${params.toString()}`;
  }, [tenantRoot, usageRange]);
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

  async function adjustCredits(event: FormEvent) {
    event.preventDefault();
    if (!tenantId || !adjustment.amountCredits.trim() || !adjustment.reason.trim()) return;
    setWorking("adjust");
    try {
      await apiRequest("/api/platform/billing/corrections", {
        method: "POST",
        body: {
          tenantId,
          amountCredits: adjustment.amountCredits.trim(),
          reason: adjustment.reason.trim(),
          reference: adjustment.reference.trim() || undefined,
        },
      });
      await Promise.all([billing.reload(), transactions.reload()]);
      setAdjustOpen(false);
      setAdjustment({ amountCredits: "", reason: "", reference: "" });
      toast.success("Tenant credits adjusted.");
    } catch (error) {
      toast.error(`Credit adjustment failed: ${readableError(error)}`);
    } finally {
      setWorking(undefined);
    }
  }

  async function createResourcePrice(event: FormEvent) {
    event.preventDefault();
    setWorking("resource-price");
    try {
      const effectiveFrom = new Date(resourcePrice.effectiveFrom);
      effectiveFrom.setSeconds(0, 0);
      await apiRequest("/api/platform/billing/price-lists", {
        method: "POST",
        body: {
          effectiveFrom: effectiveFrom.toISOString(),
          cpuCreditsPerVcpuHour: resourcePrice.cpu.trim(),
          memoryCreditsPerGbHour: resourcePrice.memory.trim(),
          storageCreditsPerGbHour: resourcePrice.storage.trim(),
          gpuCreditsPerGpuHour: resourcePrice.gpu.trim(),
        },
      });
      await prices.reload();
      setResourcePrice({
        cpu: "",
        memory: "",
        storage: "",
        gpu: "",
        effectiveFrom: defaultEffectiveFrom(),
      });
      toast.success("Resource price version created.");
    } catch (error) {
      toast.error(`Resource price could not be created: ${readableError(error)}`);
    } finally {
      setWorking(undefined);
    }
  }

  async function createAiPrice(event: FormEvent) {
    event.preventDefault();
    setWorking("ai-price");
    try {
      const effectiveFrom = new Date(aiPrice.effectiveFrom);
      effectiveFrom.setSeconds(0, 0);
      await apiRequest("/api/platform/resource-bot/prices", {
        method: "POST",
        body: {
          provider: aiPrice.provider.trim(),
          model: aiPrice.model.trim(),
          effectiveFrom: effectiveFrom.toISOString(),
          inputCreditsPer1M: aiPrice.input.trim(),
          cachedInputCreditsPer1M: aiPrice.cachedInput.trim(),
          outputCreditsPer1M: aiPrice.output.trim(),
          embeddingCreditsPer1M: aiPrice.embedding.trim(),
        },
      });
      await aiPrices.reload();
      setAiPrice((current) => ({
        ...current,
        input: "",
        cachedInput: "",
        output: "",
        embedding: "",
        effectiveFrom: defaultEffectiveFrom(),
      }));
      toast.success("AI price version created.");
    } catch (error) {
      toast.error(`AI price could not be created: ${readableError(error)}`);
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
        description="Tenant balances, usage, resource pricing, AI pricing and vouchers."
        actions={headerAction}
      />
      <BillingTabs active={activeSection} />

      {activeSection === "overview" ? (
        <>
          <section className="grid gap-4 sm:grid-cols-3">
            <MetricCard
              label="Price lists"
              value={String(priceRows.length)}
              icon={<BillingIcon />}
              loading={prices.loading}
              error={prices.error}
            />
            <MetricCard
              label="Vouchers"
              value={String(voucherRows.length)}
              icon={<BillingIcon />}
              loading={vouchers.loading}
              error={vouchers.error}
            />
            <MetricCard
              label="Accessible tenants"
              value={String(tenantRows.length)}
              icon={<UsersIcon />}
              loading={tenants.loading}
              error={tenants.error}
            />
          </section>

          <Card className="mt-6 overflow-hidden">
            <SectionTitle
              eyebrow="Tenant billing"
              title="Inspect a tenant"
              description="Select a tenant to inspect account state, quota and the same usage chart exposed to Tenant Admin."
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

              {tenantId ? (
                <>
                  <div className="mt-5 grid gap-4 lg:grid-cols-2">
                    <div className="min-w-0 rounded-lg border border-[#E1E7F0] bg-[#F8FAFD] p-4">
                      <h3 className="text-sm font-semibold">Account</h3>
                      {billing.loading ? (
                        <p className="mt-3 text-sm text-[#718096]">Loading billing state…</p>
                      ) : billing.error ? (
                        <p className="mt-3 text-sm text-[#C42B1C]">{readableError(billing.error)}</p>
                      ) : (
                        <div className="mt-3">
                          <DetailList
                            items={[
                              {
                                label: "State",
                                value: text(
                                  valueOf(billing.data, "billingState", "state"),
                                  "Unknown",
                                ),
                              },
                              {
                                label: "Balance",
                                value: `${numberText(
                                  valueOf(billing.data, "balanceCredits", "balance"),
                                  "0",
                                )} credits`,
                              },
                              {
                                label: "PLN",
                                value: numberText(valueOf(billing.data, "balancePln"), "0"),
                              },
                            ]}
                          />
                        </div>
                      )}
                    </div>

                    <div className="min-w-0 rounded-lg border border-[#E1E7F0] bg-[#F8FAFD] p-4">
                      <h3 className="text-sm font-semibold">Quota</h3>
                      {quota.loading ? (
                        <p className="mt-3 text-sm text-[#718096]">Loading quota…</p>
                      ) : quota.error ? (
                        <p className="mt-3 text-sm text-[#C42B1C]">{readableError(quota.error)}</p>
                      ) : (
                        <div className="mt-3">
                          <DetailList
                            items={[
                              { label: "CPU", value: numberText(quota.data?.cpu) },
                              { label: "Memory bytes", value: numberText(quota.data?.memoryBytes) },
                              { label: "Storage bytes", value: numberText(quota.data?.storageBytes) },
                              { label: "GPU", value: numberText(quota.data?.gpu) },
                            ]}
                          />
                        </div>
                      )}
                    </div>
                  </div>

                  {selectedTenant ? (
                    <div className="mt-4 flex flex-wrap gap-2">
                      <LinkButton href={tenantHref(tenantId, "billing")}>
                        Open {text(valueOf(selectedTenant, "displayName", "name"), "tenant")} billing
                      </LinkButton>
                      <Button onClick={() => setAdjustOpen(true)}>Adjust credits</Button>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="mt-5">
                  <EmptyState
                    title="Select a tenant"
                    description="Billing state, quota and usage remain tenant-scoped."
                  />
                </div>
              )}
            </div>
          </Card>

          {tenantId ? (
            <Card className="mt-6 overflow-hidden">
              <SectionTitle
                title="Usage"
                description="Same usage-series endpoint, ranges, metric groups and chart controls as Tenant Billing."
              />
              <BillingUsageCharts
                rows={items<Row>(usage.data)}
                loading={usage.loading}
                error={usage.error}
                range={usageRange}
                onRangeChange={setUsageRange}
              />
            </Card>
          ) : null}
        </>
      ) : null}

      {activeSection === "pricing" ? (
        <div className="space-y-6">
          <Card className="overflow-hidden">
            <SectionTitle
              eyebrow="Resources"
              title="Compute & storage pricing"
              description="Immutable, effective-dated tenant rates for CPU, memory, storage and GPU."
            />
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
            <form
              className="grid gap-4 border-t border-[#E1E7F0] bg-[#F8FAFD] p-5 sm:grid-cols-2 xl:grid-cols-5"
              onSubmit={(event) => void createResourcePrice(event)}
            >
              <Field label="CPU credits / vCPU h" required>
                <TextInput
                  inputMode="decimal"
                  value={resourcePrice.cpu}
                  onChange={(event) =>
                    setResourcePrice({ ...resourcePrice, cpu: event.target.value })
                  }
                />
              </Field>
              <Field label="Memory credits / GB h" required>
                <TextInput
                  inputMode="decimal"
                  value={resourcePrice.memory}
                  onChange={(event) =>
                    setResourcePrice({ ...resourcePrice, memory: event.target.value })
                  }
                />
              </Field>
              <Field label="Storage credits / GB h" required>
                <TextInput
                  inputMode="decimal"
                  value={resourcePrice.storage}
                  onChange={(event) =>
                    setResourcePrice({ ...resourcePrice, storage: event.target.value })
                  }
                />
              </Field>
              <Field label="GPU credits / GPU h" required>
                <TextInput
                  inputMode="decimal"
                  value={resourcePrice.gpu}
                  onChange={(event) =>
                    setResourcePrice({ ...resourcePrice, gpu: event.target.value })
                  }
                />
              </Field>
              <Field label="Effective from" required>
                <TextInput
                  type="datetime-local"
                  value={resourcePrice.effectiveFrom}
                  onChange={(event) =>
                    setResourcePrice({ ...resourcePrice, effectiveFrom: event.target.value })
                  }
                />
              </Field>
              <div className="sm:col-span-2 xl:col-span-5">
                <Button
                  type="submit"
                  variant="primary"
                  disabled={
                    working === "resource-price" ||
                    !resourcePrice.cpu.trim() ||
                    !resourcePrice.memory.trim() ||
                    !resourcePrice.storage.trim() ||
                    !resourcePrice.gpu.trim()
                  }
                >
                  {working === "resource-price" ? "Creating…" : "Create resource price version"}
                </Button>
              </div>
            </form>
          </Card>

          <Card className="overflow-hidden">
            <SectionTitle
              eyebrow="AI"
              title="ResourceBot pricing"
              description="All ResourceBot token rates are administered here rather than on the provider settings page."
            />
            {aiPrices.error ? (
              <div className="p-5">
                <Callout tone="danger" title="AI pricing unavailable">
                  {readableError(aiPrices.error)}
                </Callout>
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
            <form
              className="grid gap-4 border-t border-[#E1E7F0] bg-[#F8FAFD] p-5 sm:grid-cols-2 xl:grid-cols-4"
              onSubmit={(event) => void createAiPrice(event)}
            >
              <Field label="Provider" required>
                <TextInput
                  value={aiPrice.provider}
                  onChange={(event) =>
                    setAiPrice({ ...aiPrice, provider: event.target.value })
                  }
                />
              </Field>
              <Field label="Model" required>
                <TextInput
                  value={aiPrice.model}
                  onChange={(event) => setAiPrice({ ...aiPrice, model: event.target.value })}
                />
              </Field>
              <Field label="Input credits / 1M" required>
                <TextInput
                  inputMode="decimal"
                  value={aiPrice.input}
                  onChange={(event) => setAiPrice({ ...aiPrice, input: event.target.value })}
                />
              </Field>
              <Field label="Cached input credits / 1M" required>
                <TextInput
                  inputMode="decimal"
                  value={aiPrice.cachedInput}
                  onChange={(event) =>
                    setAiPrice({ ...aiPrice, cachedInput: event.target.value })
                  }
                />
              </Field>
              <Field label="Output credits / 1M" required>
                <TextInput
                  inputMode="decimal"
                  value={aiPrice.output}
                  onChange={(event) => setAiPrice({ ...aiPrice, output: event.target.value })}
                />
              </Field>
              <Field label="Embedding credits / 1M" required>
                <TextInput
                  inputMode="decimal"
                  value={aiPrice.embedding}
                  onChange={(event) =>
                    setAiPrice({ ...aiPrice, embedding: event.target.value })
                  }
                />
              </Field>
              <Field label="Effective from" required>
                <TextInput
                  type="datetime-local"
                  value={aiPrice.effectiveFrom}
                  onChange={(event) =>
                    setAiPrice({ ...aiPrice, effectiveFrom: event.target.value })
                  }
                />
              </Field>
              <div className="flex items-end">
                <Button
                  type="submit"
                  variant="primary"
                  disabled={
                    working === "ai-price" ||
                    !aiPrice.provider.trim() ||
                    !aiPrice.model.trim() ||
                    !aiPrice.input.trim() ||
                    !aiPrice.cachedInput.trim() ||
                    !aiPrice.output.trim() ||
                    !aiPrice.embedding.trim()
                  }
                >
                  {working === "ai-price" ? "Creating…" : "Create AI price version"}
                </Button>
              </div>
            </form>
          </Card>
        </div>
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

      <Dialog
        open={adjustOpen}
        onClose={() => setAdjustOpen(false)}
        title="Adjust tenant credits"
        description="Platform Admin only. Positive values add credits; negative values remove credits. Every adjustment is written to the billing ledger and audit log."
        actions={
          <>
            <Button onClick={() => setAdjustOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              type="submit"
              form="credit-adjustment-form"
              disabled={
                !tenantId ||
                !adjustment.amountCredits.trim() ||
                !adjustment.reason.trim() ||
                working === "adjust"
              }
            >
              Apply adjustment
            </Button>
          </>
        }
      >
        <form
          id="credit-adjustment-form"
          className="space-y-4"
          onSubmit={(event) => void adjustCredits(event)}
        >
          <Field label="Credit adjustment" required hint="Examples: 100 adds credits, -25 removes credits.">
            <TextInput
              inputMode="decimal"
              value={adjustment.amountCredits}
              onChange={(event) =>
                setAdjustment({ ...adjustment, amountCredits: event.target.value })
              }
              placeholder="100 or -25"
            />
          </Field>
          <Field label="Reason" required>
            <TextInput
              value={adjustment.reason}
              onChange={(event) =>
                setAdjustment({ ...adjustment, reason: event.target.value })
              }
              placeholder="Administrative balance correction"
            />
          </Field>
          <Field label="Reference">
            <TextInput
              value={adjustment.reference}
              onChange={(event) =>
                setAdjustment({ ...adjustment, reference: event.target.value })
              }
              placeholder="Optional ticket or invoice reference"
            />
          </Field>
        </form>
      </Dialog>
    </main>
  );
}
