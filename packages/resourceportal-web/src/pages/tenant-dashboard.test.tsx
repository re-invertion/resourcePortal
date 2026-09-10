import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TenantDashboard } from "./tenant-dashboard";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

const baseData: Record<string, unknown> = {
  "/api/tenants/t1": { id: "t1", name: "demo", displayName: "Demo", status: "Active" },
  "/api/tenants/t1/app-groups": [
    { id: "ag1", name: "web-prod", runtimeState: "Running", effectiveRuntimeState: "Running", status: "Ready", health: "Healthy", runtimeBlockers: [], singleApps: [{ id: "a1" }, { id: "a2" }] },
    { id: "ag2", name: "worker", runtimeState: "Running", effectiveRuntimeState: "Stopped", status: "Ready", health: "Healthy", runtimeBlockers: ["BillingSuspended"], singleApps: [{ id: "a3" }] },
  ],
  "/api/tenants/t1/billing": { balanceCredits: "0", balancePln: "0", billingState: "BillingSuspended", lowBalance: false },
  "/api/tenants/t1/volumes": [{ id: "v1", name: "data", sizeBytes: "10000000000", usedSizeBytes: "3000000000" }],
  "/api/tenants/t1/operations": [{ id: "op1", type: "APP_GROUP_DEPLOY", status: "Succeeded", createdAt: "2026-09-10T14:00:00.000Z" }],
};

function mockDashboard(overrides: Record<string, Response | unknown> = {}) {
  const data = { ...baseData, ...overrides };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    const value = data[path];
    if (value instanceof Response) return value;
    if (value === undefined) return json({ error: { message: `Unexpected ${path}` } }, 404);
    return json(value);
  }));
}

describe("TenantDashboard", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("summarizes the tenant around runtime, balance, storage and applications", async () => {
    mockDashboard();
    render(<TenantDashboard tenantId="t1" />);

    expect(await screen.findByRole("heading", { name: "Demo" })).toBeTruthy();
    const applications = screen.getByTestId("metric-applications");
    expect(within(applications).getByText("2")).toBeTruthy();
    expect(within(applications).getByText(/3 apps configured/i)).toBeTruthy();
    const runtime = screen.getByTestId("metric-runtime");
    expect(within(runtime).getByText(/1 running/i)).toBeTruthy();
    expect(screen.getByTestId("metric-balance").textContent).toContain("0 credits");
    expect(screen.getByTestId("metric-storage").textContent).toContain("3 GB / 10 GB");
  });

  it("turns BillingSuspended into an actionable human message", async () => {
    mockDashboard();
    render(<TenantDashboard tenantId="t1" />);

    const attention = await screen.findByRole("region", { name: "Needs attention" });
    expect(within(attention).getByText(/balance is empty/i)).toBeTruthy();
    expect(within(attention).getByRole("link", { name: /go to billing/i }).getAttribute("href")).toBe("/tenants/t1/billing");
    expect(within(attention).getByRole("link", { name: /open worker/i }).getAttribute("href")).toBe("/tenants/t1/app-groups/ag2");
  });

  it("keeps healthy panels usable when one dashboard request fails", async () => {
    mockDashboard({ "/api/tenants/t1/volumes": json({ error: { message: "Storage unavailable" } }, 503) });
    render(<TenantDashboard tenantId="t1" />);

    expect(await screen.findByText("web-prod")).toBeTruthy();
    const storage = screen.getByTestId("metric-storage");
    expect(within(storage).getByText("Unavailable")).toBeTruthy();
    expect(screen.getByTestId("metric-applications").textContent).toContain("2");
  });
});
