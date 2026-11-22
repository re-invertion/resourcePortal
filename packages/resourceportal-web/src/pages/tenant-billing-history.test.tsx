import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TenantBillingHistory, BILLING_HISTORY_ENDPOINTS } from "./tenant-billing-history";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("#399 §14 tenant billing API/UI contract", () => {
  it("uses tenant-only paths and preserves server cursor pagination", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/billing/transactions")) {
        if (url.includes("cursor=tx1")) return json({ items: [{ id: "tx2", type: "Payment", amountPln: "-2.00", amountCredits: "-200", createdAt: "2026-11-22T15:00:00Z" }], nextCursor: null });
        return json({ items: [{ id: "tx1", type: "TopUp", amountPln: "20.00", amountCredits: "2000", createdAt: "2026-11-22T14:00:00Z" }], nextCursor: "tx1" });
      }
      if (url.includes("/billing/usage-records")) return json({ items: [{ id: "u1", resourceType: "Volume", chargedPln: "0.50", chargedCredits: "50", periodStart: "2026-11-22T14:00:00Z", periodEnd: "2026-11-22T15:00:00Z" }], nextCursor: null });
      if (url.includes("/billing/usage-summary")) return json({ chargedPln: "0.50", chargedCredits: "50", theoreticalCostPln: "1.00" });
      if (url.includes("/resource-bot/usage")) return json({ items: [{ id: "b1", model: "model-a", provider: "provider-a", chargedCredits: "0.25", totalTokens: 500, status: "Succeeded", createdAt: "2026-11-22T14:00:00Z" }] });
      return json([], 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TenantBillingHistory tenantId="tenant-a" />);
    expect(await screen.findByText("TopUp")).toBeTruthy();
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes("/api/tenants/tenant-a/"))).toBe(true);
    const summaryRequest = fetchMock.mock.calls.find(([url]) => String(url).includes("/billing/usage-summary?"));
    expect(summaryRequest).toBeTruthy();
    expect(new URL(String(summaryRequest?.[0]), "https://resourceportal.test").searchParams.get("from")).toMatch(/^\\d{4}-\\d{2}-\\d{2}T/);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/billing/usage-summary"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Payment")).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("cursor=tx1"))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(await screen.findByText("TopUp")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Usage records" }));
    expect(await screen.findByText("Volume")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "ResourceBot usage" }));
    expect(await screen.findByText("model-a")).toBeTruthy();
    expect(screen.getByText(/at most the 50 latest ResourceBot records/)).toBeTruthy();
    expect(BILLING_HISTORY_ENDPOINTS.summary).toBe("/billing/usage-summary");
  });

  it("reports unavailable billing records rather than showing an empty history", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/billing/transactions")) return json({ message: "forbidden" }, 403);
      return json({ items: [] });
    }));
    render(<TenantBillingHistory tenantId="tenant-b" />);
    expect((await screen.findByRole("alert")).textContent).toContain("Billing records could not be loaded");
    expect(screen.queryByText("No records in this loaded history page.")).toBeNull();
  });
});
