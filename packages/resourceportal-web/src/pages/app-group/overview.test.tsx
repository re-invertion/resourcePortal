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

it("renders readable App Group and embedded app statuses, preserving raw status semantics", () => {
  render(<AppGroupOverview tenantId="t1" group={{
    id: "ag-status", name: "services", runtimeState: "PENDING_DEPLOYMENT",
    effectiveRuntimeState: "STARTING_UP", health: "HEALTH_CHECK_PENDING",
    driftStatus: "OUT_OF_SYNC", hasPendingChanges: true,
    singleApps: [{ id: "app1", name: "queue-worker", runtimeState: "PENDING_DEPLOYMENT",
      effectiveRuntimeState: "STARTING_UP", health: "HEALTH_CHECK_PENDING" }],
  }} />);
  expect(screen.getByText("Pending deployment")).toBeTruthy();
  expect(screen.getAllByText("Starting up").length).toBeGreaterThan(0);
  expect(screen.getByText("Health check pending")).toBeTruthy();
  expect(screen.getByText("Out of sync")).toBeTruthy();
  for (const technical of ["PENDING_DEPLOYMENT", "STARTING_UP", "HEALTH_CHECK_PENDING", "OUT_OF_SYNC"]) {
    expect(screen.queryByText(technical)).toBeNull();
  }
});
