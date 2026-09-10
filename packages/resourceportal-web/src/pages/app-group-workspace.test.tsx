import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppGroupWorkspace } from "./app-group-workspace";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

const appGroup = {
  id: "ag1",
  name: "web-prod",
  runtimeState: "Stopped",
  effectiveRuntimeState: "Stopped",
  status: "Ready",
  health: "Healthy",
  driftStatus: "InSync",
  runtimeBlockers: ["BillingSuspended"],
  hasPendingChanges: true,
  currentDeploymentVersion: 12,
  lastDeploymentAt: "2026-09-10T14:00:00.000Z",
};

describe("AppGroupWorkspace", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(appGroup)));
  });

  it("presents App Group state as an operational workspace", async () => {
    render(<AppGroupWorkspace tenantId="t1" appGroupId="ag1" apps={<p>Apps content</p>} config={<p>Config content</p>} networking={<p>Networking content</p>} deployments={<p>Deployments content</p>} activity={<p>Activity content</p>} advanced={<p>Stack preview content</p>} />);

    expect(await screen.findByRole("heading", { name: "web-prod" })).toBeTruthy();
    const header = screen.getByTestId("app-group-header");
    expect(within(header).getByText("Stopped")).toBeTruthy();
    expect(within(header).getByText("Healthy")).toBeTruthy();
    expect(within(header).getByText("InSync")).toBeTruthy();
    expect(within(header).getByText(/pending changes/i)).toBeTruthy();
    expect(within(header).getByRole("link", { name: /deploy changes/i }).getAttribute("href")).toBe("#deployments");
  });

  it("uses task-oriented section navigation and keeps technical output under Advanced", async () => {
    render(<AppGroupWorkspace tenantId="t1" appGroupId="ag1" apps={<p>Apps content</p>} config={<p>Config content</p>} networking={<p>Networking content</p>} deployments={<p>Deployments content</p>} activity={<p>Activity content</p>} advanced={<p>Stack preview content</p>} />);
    await screen.findByRole("heading", { name: "web-prod" });

    const nav = screen.getByRole("navigation", { name: "App Group sections" });
    for (const label of ["Overview", "Apps", "Config", "Networking", "Deployments", "Activity"]) {
      expect(within(nav).getByRole("link", { name: label })).toBeTruthy();
    }
    const advanced = screen.getByText("Advanced & technical details").closest("details");
    expect(advanced).toBeTruthy();
    expect(within(advanced as HTMLElement).getByText("Stack preview content")).toBeTruthy();
  });

  it("does not show an alert when the App Group is intentionally stopped", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ ...appGroup, runtimeBlockers: ["AppGroupStopped"], hasPendingChanges: false })));
    render(<AppGroupWorkspace tenantId="t1" appGroupId="ag1" apps={<p>Apps content</p>} config={<p>Config content</p>} networking={<p>Networking content</p>} deployments={<p>Deployments content</p>} activity={<p>Activity content</p>} advanced={<p>Stack preview content</p>} />);

    expect(await screen.findByRole("heading", { name: "web-prod" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("explains billing runtime blockers before the user retries Start", async () => {
    render(<AppGroupWorkspace tenantId="t1" appGroupId="ag1" apps={<p>Apps content</p>} config={<p>Config content</p>} networking={<p>Networking content</p>} deployments={<p>Deployments content</p>} activity={<p>Activity content</p>} advanced={<p>Stack preview content</p>} />);
    await screen.findByRole("heading", { name: "web-prod" });

    const blocker = screen.getByRole("alert");
    expect(within(blocker).getByText(/balance is empty/i)).toBeTruthy();
    expect(within(blocker).getByRole("link", { name: /add credits/i }).getAttribute("href")).toBe("/tenants/t1/billing");
    expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
