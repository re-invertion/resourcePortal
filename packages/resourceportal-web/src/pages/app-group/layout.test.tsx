import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
it("keeps App Group navigation route-based and includes Settings", () => {
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
  expect(nav?.textContent).toContain("Settings");
  expect(nav?.textContent).not.toContain("Networking");
  expect(Array.from(nav?.querySelectorAll("a") ?? []).every((link) => !link.getAttribute("href")?.startsWith("#"))).toBe(true);
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


it("discards pending changes from the App Group header after confirmation", async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  const onReload = vi.fn().mockResolvedValue(undefined);

  render(
    <AppGroupLayout
      tenantId="t1"
      group={{ id: "ag1", name: "Commerce", runtimeState: "Running", effectiveRuntimeState: "Running", health: "Healthy", driftStatus: "InSync", hasPendingChanges: true }}
      section="overview"
      onReload={onReload}
    >
      <p>Overview</p>
    </AppGroupLayout>,
  );

  fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
  const dialog = screen.getByRole("dialog", { name: "Discard pending changes?" });
  expect(fetchMock).not.toHaveBeenCalled();

  fireEvent.click(within(dialog).getByRole("button", { name: "Discard changes" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  expect(String(fetchMock.mock.calls[0][0])).toBe("/api/tenants/t1/app-groups/ag1/discard-changes");
  expect(onReload).toHaveBeenCalledTimes(1);
});

it("disables Discard changes when the App Group has no pending changes", () => {
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

  expect((screen.getByRole("button", { name: "Discard changes" }) as HTMLButtonElement).disabled).toBe(true);
});