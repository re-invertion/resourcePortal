import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppGroupLayout } from "./layout";

describe("AppGroupLayout Penpot metrics", () => {
  it("renders the App Group mark at 52px", () => {
    const { container } = render(
      <AppGroupLayout
        tenantId="t1"
        group={{ id: "ag1", name: "Commerce", runtimeState: "Stopped", effectiveRuntimeState: "Stopped", health: "Healthy", driftStatus: "InSync", hasPendingChanges: false }}
        section="overview"
        onReload={vi.fn(async () => undefined)}
      >
        <p>Overview</p>
      </AppGroupLayout>,
    );
    const mark = container.querySelector("h1 svg")?.parentElement;
    expect(mark?.className).toContain("h-[52px]");
    expect(mark?.className).toContain("w-[52px]");
  });
});
it("keeps the Penpot App Group navigation to the six primary sections", () => {
  render(
    <AppGroupLayout
      tenantId="t1"
      group={{ id: "ag1", name: "Commerce", runtimeState: "Running", effectiveRuntimeState: "Running", health: "Healthy", driftStatus: "InSync", hasPendingChanges: false }}
      section="overview"
      onReload={vi.fn(async () => undefined)}
    >
      <p>Overview</p>
    </AppGroupLayout>,
  );
  const nav = document.querySelector('nav[aria-label="App Group sections"]');
  expect(nav).toBeTruthy();
  expect(nav?.querySelectorAll("a")).toHaveLength(6);
  expect(nav?.textContent).not.toContain("Settings");
});

it("uses the Penpot pending changes banner copy", () => {
  render(
    <AppGroupLayout
      tenantId="t1"
      group={{ id: "ag1", name: "Commerce", runtimeState: "Running", effectiveRuntimeState: "Running", health: "Healthy", driftStatus: "InSync", hasPendingChanges: true }}
      section="overview"
      onReload={vi.fn(async () => undefined)}
    >
      <p>Overview</p>
    </AppGroupLayout>,
  );
  expect(document.body.textContent).toContain("Changes are waiting to be deployed");
  expect(document.body.textContent).toContain("Review the deployment section when you are ready to publish them.");
});


it("labels App Group statuses and exposes explanatory tooltips", () => {
  render(
    <AppGroupLayout
      tenantId="t1"
      group={{ id: "ag1", name: "Commerce", runtimeState: "Running", effectiveRuntimeState: "Running", health: "Healthy", driftStatus: "InSync", hasPendingChanges: true }}
      section="overview"
      onReload={vi.fn(async () => undefined)}
    >
      <p>Overview</p>
    </AppGroupLayout>,
  );

  for (const label of ["Runtime", "Health", "Sync", "Draft"]) expect(screen.getByText(label)).toBeTruthy();
  expect(screen.getByText("Running")).toBeTruthy();
  expect(screen.getByText("Healthy")).toBeTruthy();
  expect(screen.getByText("In sync")).toBeTruthy();
  expect(screen.getByText("Pending changes")).toBeTruthy();

  const tooltips = screen.getAllByRole("tooltip");
  expect(tooltips).toHaveLength(4);
  expect(screen.getByText(/Effective runtime state after tenant, billing and platform blockers/i)).toBeTruthy();
  expect(screen.getByText(/Health compares expected replicas with the workloads observed/i)).toBeTruthy();
  expect(screen.getByText(/Sync compares the deployed service set, images and desired replica counts/i)).toBeTruthy();
  expect(screen.getByText(/workspace contains edits that are not part of the current deployed revision/i)).toBeTruthy();

  const trigger = screen.getByText("Runtime").closest("[aria-describedby]");
  expect(trigger).toBeTruthy();
  expect(document.getElementById(trigger?.getAttribute("aria-describedby") ?? "")?.getAttribute("role")).toBe("tooltip");
});
