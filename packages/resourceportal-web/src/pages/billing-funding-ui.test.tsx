import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TenantBilling } from "./tenant-resources";
import { PlatformBillingPage } from "./platform-final-pages";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("billing funding UI", () => {
  it("offers tenants voucher redemption instead of arbitrary top-up", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/tenants/t1/billing" && method === "GET") {
        return json({ balanceCredits: "25", balancePln: "0.25", billingState: "Active" });
      }
      if (url === "/api/tenants/t1/quota") {
        return json({ cpu: 2, memoryBytes: 1024, gpu: 0, storageBytes: 2048, maxSingleApps: 5, maxVolumes: 5 });
      }
      if (url === "/api/tenants/t1/billing/transactions") return json([]);
      if (url.startsWith("/api/tenants/t1/billing/usage-series?")) return json([]);
      if (url === "/api/tenants/t1/billing/vouchers/redeem" && method === "POST") {
        return json({ billing: { balanceCredits: "125" } });
      }
      return json({ error: { message: `Unexpected ${method} ${url}` } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TenantBilling tenantId="t1" />);

    expect(await screen.findByRole("heading", { name: "Billing", level: 1 })).toBeTruthy();
    expect(screen.queryByText("Top up balance")).toBeNull();
    expect(screen.queryByRole("button", { name: "Top up" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Redeem voucher" })).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("RPV-…"), {
      target: { value: "rpv-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Redeem voucher" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([input, init]) =>
          String(input) === "/api/tenants/t1/billing/vouchers/redeem" &&
          init?.method === "POST",
      );
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        code: "RPV-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      });
    });

    expect(
      fetchMock.mock.calls.some(([input]) => String(input).includes("/billing/top-up")),
    ).toBe(false);
  });

  it("renders usage amounts, range controls, and no tenant Transactions table", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/tenants/t1/billing") return json({ balanceCredits: "25", balancePln: "0.25", billingState: "Active" });
      if (url === "/api/tenants/t1/quota") return json({ cpu: 2, memoryBytes: 1024, gpu: 0, storageBytes: 2048, maxSingleApps: 5, maxVolumes: 5 });
      if (url.startsWith("/api/tenants/t1/billing/usage-series?")) return json({ items: [{
        id: "usage-1",
        resourceType: "SingleApp",
        periodStart: "2026-09-19T11:16:00.000Z",
        chargedCredits: "0",
        chargedPln: "0",
        theoreticalCostCredits: "0",
        usage: {
          billedReplicas: 0,
          desiredReplicas: 1,
          cpuPerReplica: "0.5",
          memoryBytesPerReplica: "536870912",
        },
      }] });
      return json([]);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TenantBilling tenantId="t1" />);

    expect(await screen.findByRole("heading", { name: "Usage" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Transactions" })).toBeNull();
    expect(screen.getAllByText("0 credits").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/0 PLN/)).toBeTruthy();
    expect(screen.getAllByText("Theoretical").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/latest 0\/1 billed\/desired/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "7d" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Credits" }).getAttribute("aria-pressed")).toBe("true");
    const firstUsageUrl = String(fetchMock.mock.calls.find(([input]) => String(input).startsWith("/api/tenants/t1/billing/usage-series?"))?.[0]);
    const firstUsageParams = new URL(firstUsageUrl, "http://resourceportal.test").searchParams;
    expect(firstUsageParams.get("bucket")).toBe("2h");
    expect(firstUsageParams.get("from")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "30d" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "30d" }).getAttribute("aria-pressed")).toBe("true");
      expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/tenants/t1/billing/usage-series?")).length).toBeGreaterThanOrEqual(2);
    });

    expect(screen.queryByText("Transactions")).toBeNull();
  });

  it("lets Platform Admin adjust tenant credits through the correction endpoint", async () => {
    const tenantId = "44444444-4444-4444-8444-444444444444";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/tenants") return json([{ id: tenantId, name: "Commerce" }]);
      if (url === "/api/platform/billing/price-lists") return json([]);
      if (url === "/api/platform/billing/vouchers") return json([]);
      if (url === `/api/tenants/${tenantId}/billing`) return json({ balanceCredits: "100", billingState: "Active" });
      if (url === `/api/tenants/${tenantId}/quota`) return json({});
      if (url === `/api/tenants/${tenantId}/billing/transactions?limit=20`) return json([]);
      if (url === `/api/tenants/${tenantId}/billing/usage-records?limit=20`) return json([]);
      if (url === "/api/platform/billing/corrections" && method === "POST") {
        return json({ billing: { balanceCredits: "150" } });
      }
      return json({ error: { message: `Unexpected ${method} ${url}` } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<PlatformBillingPage />);

    await screen.findByRole("heading", { name: "Billing", level: 1 });
    fireEvent.change(screen.getByLabelText("Tenant"), { target: { value: tenantId } });
    await screen.findByRole("button", { name: "Adjust credits" });
    fireEvent.click(screen.getByRole("button", { name: "Adjust credits" }));

    fireEvent.change(screen.getByPlaceholderText("100 or -25"), {
      target: { value: "50" },
    });
    fireEvent.change(screen.getByPlaceholderText("Administrative balance correction"), {
      target: { value: "Support-approved correction" },
    });
    fireEvent.change(screen.getByPlaceholderText("Optional ticket or invoice reference"), {
      target: { value: "TICKET-123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply adjustment" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([input, init]) =>
          String(input) === "/api/platform/billing/corrections" &&
          init?.method === "POST",
      );
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        tenantId,
        amountCredits: "50",
        reason: "Support-approved correction",
        reference: "TICKET-123",
      });
    });
  });
});
it("uses the tenant usage-series contract and identical chart controls in Platform Billing", async () => {
  const tenantId = "44444444-4444-4444-8444-444444444444";
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/tenants") return json([{ id: tenantId, name: "Commerce" }]);
    if (url === "/api/platform/billing/price-lists") return json([]);
    if (url === "/api/platform/billing/vouchers") return json([]);
    if (url === "/api/platform/resource-bot/prices") return json({ items: [] });
    if (url === "/api/platform/resource-bot") return json({ provider: "OpenAI", generationModel: "gpt-5.6-luna" });
    if (url === `/api/tenants/${tenantId}/billing`) return json({ balanceCredits: "100", billingState: "Active" });
    if (url === `/api/tenants/${tenantId}/quota`) return json({ cpu: 2, memoryBytes: 1024, storageBytes: 2048, gpu: 0 });
    if (url === `/api/tenants/${tenantId}/billing/transactions?limit=20`) return json([]);
    if (url.startsWith(`/api/tenants/${tenantId}/billing/usage-series?`)) {
      return json({ items: [{
        id: "usage-1",
        periodStart: "2026-09-28T12:00:00.000Z",
        chargedCredits: "1.25",
        chargedPln: "0.0125",
        theoreticalCostCredits: "1.5",
        usage: { billedReplicas: 1, desiredReplicas: 2 },
      }] });
    }
    return json({ error: { message: `Unexpected ${url}` } }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<PlatformBillingPage />);
  fireEvent.change(await screen.findByLabelText("Tenant"), { target: { value: tenantId } });

  expect(await screen.findByRole("heading", { name: "Usage" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "7d" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button", { name: "Credits" }).getAttribute("aria-pressed")).toBe("true");

  const usageUrl = String(fetchMock.mock.calls.find(([input]) =>
    String(input).startsWith(`/api/tenants/${tenantId}/billing/usage-series?`),
  )?.[0]);
  const params = new URL(usageUrl, "http://resourceportal.test").searchParams;
  expect(params.get("bucket")).toBe("2h");
  expect(params.get("from")).toBeTruthy();
});

it("centralizes resource and AI tariff administration in Billing Pricing", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/tenants") return json([]);
    if (url === "/api/platform/billing/vouchers") return json([]);
    if (url === "/api/platform/billing/price-lists") return json([{
      id: "price-1",
      version: 3,
      effectiveFrom: "2026-09-28T12:00:00.000Z",
      cpuCreditsPerVcpuHour: "1",
      memoryCreditsPerGbHour: "2",
      storageCreditsPerGbHour: "3",
      gpuCreditsPerGpuHour: "4",
    }]);
    if (url === "/api/platform/resource-bot/prices") return json({ items: [{
      id: "ai-1",
      provider: "OpenAI",
      model: "gpt-5.6-luna",
      effectiveFrom: "2026-09-28T12:00:00.000Z",
      inputCreditsPer1M: "5",
      cachedInputCreditsPer1M: "6",
      outputCreditsPer1M: "7",
      embeddingCreditsPer1M: "8",
    }] });
    if (url === "/api/platform/resource-bot") return json({ provider: "OpenAI", generationModel: "gpt-5.6-luna" });
    return json({ error: { message: `Unexpected ${url}` } }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<PlatformBillingPage activeSection="pricing" />);

  expect(await screen.findByRole("heading", { name: "Compute & storage pricing" })).toBeTruthy();
  expect(screen.getByRole("columnheader", { name: "GPU / h" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "ResourceBot pricing" })).toBeTruthy();
  expect(screen.getByRole("columnheader", { name: "Embedding / 1M" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Pricing" }).getAttribute("aria-current")).toBe("page");
});

it("shows persistent voucher codes and captures an optional expiration date when Platform Admin creates one", async () => {
  const created = {
    id: "voucher-2",
    code: "RPV-NEWVISIBLECODE1234567890",
    valueCredits: "250",
    status: "Active",
    expiresAt: "2026-10-01T10:30:00.000Z",
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/tenants") return json([]);
    if (url === "/api/platform/billing/price-lists") return json([]);
    if (url === "/api/platform/billing/vouchers" && method === "GET") {
      return json([{
        id: "voucher-1",
        code: "RPV-PERSISTEDCODE1234567890",
        valueCredits: "100",
        status: "Active",
        expiresAt: null,
      }]);
    }
    if (url === "/api/platform/billing/vouchers" && method === "POST") return json(created);
    return json({ error: { message: `Unexpected ${method} ${url}` } }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<PlatformBillingPage activeSection="vouchers" />);

  expect(await screen.findByText("RPV-PERSISTEDCODE1234567890")).toBeTruthy();
  expect(screen.getByRole("columnheader", { name: "Code" })).toBeTruthy();
  expect(screen.getByText("Never")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Create voucher" }));
  expect(screen.getByLabelText("Expiration date")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Credit value"), { target: { value: "250" } });
  fireEvent.change(screen.getByLabelText("Expiration date"), { target: { value: "2026-10-01T12:30" } });
  const voucherDialog = screen.getByRole("dialog", { name: "Create voucher" });
  fireEvent.click(within(voucherDialog).getByRole("button", { name: "Create voucher" }));

  await waitFor(() => {
    const call = fetchMock.mock.calls.find(([input, init]) =>
      String(input) === "/api/platform/billing/vouchers" && init?.method === "POST",
    );
    expect(call).toBeTruthy();
    const body = JSON.parse(String(call?.[1]?.body));
    expect(body.valueCredits).toBe("250");
    expect(body.expiresAt).toBe(new Date("2026-10-01T12:30").toISOString());
  });
  expect(await screen.findByRole("heading", { name: "Voucher created" })).toBeTruthy();
  expect(screen.getByText("RPV-NEWVISIBLECODE1234567890")).toBeTruthy();
});
