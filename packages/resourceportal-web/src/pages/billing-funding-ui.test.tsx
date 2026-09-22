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
      if (url === "/api/tenants/t1/billing/usage-records") return json([]);
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

  it("renders transaction and usage amounts from the real billing API fields", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/tenants/t1/billing") return json({ balanceCredits: "25", balancePln: "0.25", billingState: "Active" });
      if (url === "/api/tenants/t1/quota") return json({ cpu: 2, memoryBytes: 1024, gpu: 0, storageBytes: 2048, maxSingleApps: 5, maxVolumes: 5 });
      if (url === "/api/tenants/t1/billing/transactions") return json({ items: [{
        id: "tx-1",
        type: "Correction",
        amountCredits: "-25",
        amountPln: "-0.25",
        createdAt: "2026-09-19T11:13:55.182Z",
      }] });
      if (url === "/api/tenants/t1/billing/usage-records") return json({ items: [{
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

    expect(await screen.findByText("-25 credits")).toBeTruthy();
    expect(screen.getByText("-0.25 PLN")).toBeTruthy();
    expect(screen.getByText("0 credits")).toBeTruthy();
    expect(screen.getByText(/0 PLN/)).toBeTruthy();
    expect(screen.getByText(/theoretical 0 credits/)).toBeTruthy();
    expect(screen.getByText(/0\/1 replicas billed/)).toBeTruthy();
    expect(screen.queryByText("—")).toBeNull();
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

  render(<PlatformBillingPage />);

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
