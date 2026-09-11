import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppGroupsPage } from "./app-groups";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("AppGroupsPage", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("renders only curated cloud-resource columns and ignores unknown backend fields", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json([{
      id: "group-1",
      name: "shop-production",
      runtimeState: "Running",
      effectiveRuntimeState: "Running",
      health: "Healthy",
      driftStatus: "InSync",
      hasPendingChanges: false,
      currentDeploymentVersion: 7,
      updatedAt: "2026-09-11T08:00:00.000Z",
      internalSchedulerHint: "do-not-render",
    }])));

    render(<AppGroupsPage tenantId="tenant-1" permissions={["appgroup.create", "appgroup.delete"]} />);

    const resourceLink = await screen.findByRole("link", { name: "shop-production" });
    expect(resourceLink.getAttribute("href")).toBe("/tenants/tenant-1/app-groups/group-1");
    expect(screen.getByRole("columnheader", { name: "Name" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Status" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Health" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Drift" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Deployment" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Changes" })).toBeTruthy();
    expect(screen.queryByText("internalSchedulerHint")).toBeNull();
    expect(screen.queryByText("do-not-render")).toBeNull();
  });

  it("opens a guided AppGroup creation flow from the page command bar", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json([])));

    render(<AppGroupsPage tenantId="tenant-1" permissions={["appgroup.create"]} />);

    await screen.findByRole("heading", { name: "App Groups" });
    fireEvent.click(screen.getByRole("button", { name: "Create AppGroup" }));

    expect(screen.getByRole("heading", { name: "Create AppGroup" })).toBeTruthy();
    expect(screen.getByText("Basics")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review + create" })).toBeTruthy();
  });
});
