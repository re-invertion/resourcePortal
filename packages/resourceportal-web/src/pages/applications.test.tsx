import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationsPage, appGroupMatchesSearch } from "./applications";

function json(value: unknown) { return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } }); }
const groups = [
  { id: "ag1", name: "commerce-prod", singleApps: [{ id: "a1" }, { id: "a2" }], effectiveRuntimeState: "Running", runtimeState: "Running", health: "Healthy", currentDeploymentVersion: 12, hasPendingChanges: false, updatedAt: "2026-09-13T18:00:00Z" },
  { id: "ag2", name: "sandbox", singleApps: [], effectiveRuntimeState: "Stopped", runtimeState: "Stopped", health: "Unknown", currentDeploymentVersion: null, hasPendingChanges: true, updatedAt: "2026-09-12T10:00:00Z" },
];

describe("ApplicationsPage", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(groups))));
  it("renders the Penpot application inventory with real App Group data", async () => {
    render(<ApplicationsPage tenantId="t1" />);
    expect(await screen.findByRole("heading", { name: "Applications" })).toBeTruthy();
    expect(screen.getByText("commerce-prod")).toBeTruthy();
    expect(screen.getByText("v12")).toBeTruthy();
    expect(screen.getByText("Pending changes")).toBeTruthy();
    expect(screen.getByRole("link", { name: /create app group/i }).getAttribute("href")).toBe("/tenants/t1/applications/new");
    expect(screen.getByRole("link", { name: /import yaml/i }).getAttribute("href")).toBe("/tenants/t1/applications/import");
    fireEvent.click(screen.getByRole("button", { name: /create application/i }));
    expect(screen.getByRole("link", { name: "commerce-prod" }).getAttribute("href")).toBe("/tenants/t1/app-groups/ag1/apps/new");
    expect(screen.getByRole("link", { name: /create new app group/i }).getAttribute("href")).toBe("/tenants/t1/applications/new");
    const row = screen.getAllByText("commerce-prod").find(node => node.closest("tr"))?.closest("tr") as HTMLElement;
    expect(within(row).getByText("2 apps")).toBeTruthy();
  });
  it("filters inventory without changing backend truth", async () => {
    render(<ApplicationsPage tenantId="t1" />);
    await screen.findByText("commerce-prod");
    fireEvent.change(screen.getByRole("textbox", { name: "Search App Groups" }), { target: { value: "sand" } });
    expect(screen.queryByText("commerce-prod")).toBeNull();
    expect(screen.getByText("sandbox")).toBeTruthy();
  });

  it("keeps cached App Groups visible during a failed background poll and recovers on retry", async () => {
    const updated = [{ ...groups[0], name: "commerce-recovered" }, groups[1]];
    const fetchMock = vi.fn().mockResolvedValueOnce(json(groups))
      .mockRejectedValueOnce(new Error("temporary network outage"))
      .mockResolvedValueOnce(json(updated));
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    const view = render(<ApplicationsPage tenantId="t1" />);
    try {
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(screen.getByText("commerce-prod")).toBeTruthy();
      fireEvent.change(screen.getByRole("textbox", { name: "Search App Groups" }), { target: { value: "commerce" } });

      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(screen.getByText("commerce-prod")).toBeTruthy();
      expect(screen.getByRole("status").textContent).toMatch(/last loaded data/i);
      expect(screen.queryByText(/Applications could not be loaded/)).toBeNull();

      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(screen.getByText("commerce-recovered")).toBeTruthy();
      expect(screen.queryByText("commerce-prod")).toBeNull();
      expect(screen.queryByText(/Showing the last loaded data/)).toBeNull();
      expect(screen.queryByText("sandbox")).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it("keeps the initial loading error blocking until the first successful response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    render(<ApplicationsPage tenantId="t1" />);
    expect(await screen.findByText(/Applications could not be loaded/)).toBeTruthy();
    expect(screen.queryByText("commerce-prod")).toBeNull();
    expect(screen.queryByText(/Showing the last loaded data/)).toBeNull();
  });

  it("refreshes the visible app inventory without dropping the search filter", async () => {
    const newer = [{ ...groups[0], name: "commerce-next" }, groups[1]];
    const fetchMock = vi.fn().mockImplementationOnce(async () => json(groups))
      .mockImplementation(async () => json(newer));
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    const view = render(<ApplicationsPage tenantId="t1" />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByText("commerce-prod")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Search App Groups" }), { target: { value: "commerce" } });
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(screen.getByText("commerce-next")).toBeTruthy();
      expect(screen.queryByText("commerce-prod")).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      view.unmount();
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("#399 App Group inventory discoverability and bounded history", () => {
  it("matches App Groups by child application name and ID without resolving other tenant data", () => {
    expect(appGroupMatchesSearch({ name: "commerce", id: "ag1", singleApps: [{ id: "api-42", name: "payments-api" }] }, "PAYMENTS")).toBe(true);
    expect(appGroupMatchesSearch({ name: "commerce", id: "ag1", singleApps: [{ id: "api-42", name: "payments-api" }] }, "api-42")).toBe(true);
    expect(appGroupMatchesSearch({ name: "commerce", id: "ag1" }, "payments")).toBe(false);
    expect(appGroupMatchesSearch({ name: "commerce" }, "   ")).toBe(true);
  });

  it("paginates 45 groups, resets to page one after filtering, and provides a clear-filters action", async () => {
    const many = Array.from({ length: 45 }, (_, i) => ({
      id: `ag-${i + 1}`, name: `group-${i + 1}`,
      singleApps: [{ id: `app-${i + 1}`, name: `service-${i + 1}` }],
      runtimeState: "Running", health: "Healthy",
    }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(many)));
    render(<ApplicationsPage tenantId="t1" />);
    expect(await screen.findByText("1–20 of 45")).toBeTruthy();
    expect(screen.getAllByRole("row")).toHaveLength(21);
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByText("21–40 of 45")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByText("41–45 of 45")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Next page" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Search App Groups" }), { target: { value: "service-42" } });
    expect(screen.getByText("group-42")).toBeTruthy();
    expect(screen.queryByText("group-41")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("1–20 of 45")).toBeTruthy();
  });
});
