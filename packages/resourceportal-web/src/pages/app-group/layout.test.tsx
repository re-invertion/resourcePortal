import { render } from "@testing-library/react";
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
