import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { AppGroupOverview } from "./overview";

it("keeps advanced settings reachable outside the six primary App Group tabs", () => {
  render(<AppGroupOverview tenantId="t1" group={{ id: "ag1", name: "commerce", runtimeState: "Running", effectiveRuntimeState: "Running", health: "Healthy", driftStatus: "InSync", hasPendingChanges: false, singleApps: [] }} />);
  const link = screen.getByRole("link", { name: /advanced & technical details/i });
  expect(link.getAttribute("href")).toBe("/tenants/t1/app-groups/ag1/advanced");
  expect(screen.getByText(/stack preview, raw detail and draft controls/i)).toBeTruthy();
  expect(screen.getByText("Effective state")).toBeTruthy();
  expect(screen.getByText(/0 applications in this App Group/i)).toBeTruthy();
});

it("#399 §13 separates intentional stop, health, sync, draft and attention", () => {
  render(<AppGroupOverview tenantId="t1" group={{
    id: "ag2", name: "paused", runtimeState: "Stopped", effectiveRuntimeState: "Stopped",
    health: "Healthy", driftStatus: "InSync", hasPendingChanges: false,
    runtimeBlockers: ["AppGroupStopped"], singleApps: [],
  }} />);
  expect(screen.getByText(/Stopped intentionally; expected replicas 0/)).toBeTruthy();
  expect(screen.getByRole("group", { name: "Independent deployment state dimensions" })).toBeTruthy();
  expect(screen.getByText("No known blocker")).toBeTruthy();
  expect(screen.getByText("Up to date")).toBeTruthy();
});
