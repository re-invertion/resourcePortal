import { fireEvent, render, screen, within } from "@testing-library/react";
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

const contentProps = {
  apps: <p>Apps content</p>,
  config: <p>Config content</p>,
  networking: <p>Networking content</p>,
  deployments: <p>Deployments content</p>,
  activity: <p>Activity content</p>,
  advanced: <p>Stack preview content</p>,
};

describe("AppGroupWorkspace", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(appGroup)));
  });

  it("presents App Group state with a semantic resource header and one-line command bar", async () => {
    render(<AppGroupWorkspace tenantId="t1" appGroupId="ag1" {...contentProps} />);

    expect(await screen.findByRole("heading", { name: "web-prod" })).toBeTruthy();
    const header = screen.getByTestId("app-group-header");
    expect(header.querySelector('[data-rp-icon="app-group"]')).not.toBeNull();
    expect(within(header).getByText("App Group")).toBeTruthy();
    expect(within(header).getByText("Stopped")).toBeTruthy();
    expect(within(header).getByText("Healthy")).toBeTruthy();
    expect(within(header).getByText("InSync")).toBeTruthy();
    expect(within(header).getByText(/pending changes/i)).toBeTruthy();

    const toolbar = screen.getByRole("toolbar", { name: "App Group actions" });
    expect(within(toolbar).getByRole("link", { name: /deploy changes/i }).getAttribute("href")).toBe("#deployments");
    expect(within(toolbar).getByRole("button", { name: "Start" })).toBeTruthy();
    expect(within(toolbar).getByRole("button", { name: "More actions" })).toBeTruthy();

    fireEvent.click(within(toolbar).getByRole("button", { name: "More actions" }));
    expect(screen.getByRole("menu", { name: "More actions" })).toBeTruthy();
  });

  it("uses task-oriented section navigation and renders a curated Essentials section without raw technical output", async () => {
    render(<AppGroupWorkspace tenantId="t1" appGroupId="ag1" {...contentProps} />);
    await screen.findByRole("heading", { name: "web-prod" });

    const nav = screen.getByRole("navigation", { name: "App Group sections" });
    for (const label of ["Overview", "Apps", "Config", "Networking", "Deployments", "Activity"]) {
      expect(within(nav).getByRole("link", { name: label })).toBeTruthy();
    }

    const essentials = screen.getByRole("region", { name: "Essentials" });
    expect(within(essentials).getByText("Desired state")).toBeTruthy();
    expect(within(essentials).getByText("Effective state")).toBeTruthy();
    expect(within(essentials).getByText("Health")).toBeTruthy();
    expect(within(essentials).getByText("Current deployment")).toBeTruthy();
    expect(within(essentials).getByText("v12")).toBeTruthy();
    expect(screen.queryByText("Advanced & technical details")).toBeNull();
    expect(screen.queryByText("Stack preview content")).toBeNull();
  });

  it("does not show an alert when the App Group is intentionally stopped", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ ...appGroup, runtimeBlockers: ["AppGroupStopped"], hasPendingChanges: false })));
    render(<AppGroupWorkspace tenantId="t1" appGroupId="ag1" {...contentProps} />);

    expect(await screen.findByRole("heading", { name: "web-prod" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("explains billing runtime blockers before the user retries Start", async () => {
    render(<AppGroupWorkspace tenantId="t1" appGroupId="ag1" {...contentProps} />);
    await screen.findByRole("heading", { name: "web-prod" });

    const blocker = screen.getByRole("alert");
    expect(within(blocker).getByText(/balance is empty/i)).toBeTruthy();
    expect(within(blocker).getByRole("link", { name: /add credits/i }).getAttribute("href")).toBe("/tenants/t1/billing");
    expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
