import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationsPage } from "./applications";

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
