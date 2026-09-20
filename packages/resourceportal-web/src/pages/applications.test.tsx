import { fireEvent, render, screen, within } from "@testing-library/react";
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
    const row = screen.getByText("commerce-prod").closest("tr") as HTMLElement;
    expect(within(row).getByText("2 apps")).toBeTruthy();
  });
  it("filters inventory without changing backend truth", async () => {
    render(<ApplicationsPage tenantId="t1" />);
    await screen.findByText("commerce-prod");
    fireEvent.change(screen.getByRole("textbox", { name: "Search App Groups" }), { target: { value: "sand" } });
    expect(screen.queryByText("commerce-prod")).toBeNull();
    expect(screen.getByText("sandbox")).toBeTruthy();
  });
});
