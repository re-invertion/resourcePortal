import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppGroupRoute } from "./route";

function json(value: unknown) { return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } }); }

const group = { id: "ag1", name: "commerce", runtimeState: "Running", effectiveRuntimeState: "Running", health: "Healthy", driftStatus: "InSync", hasPendingChanges: false };
const app = { id: "app1", name: "checkout", image: "ghcr.io/acme/checkout:1", runtimeState: "Running", effectiveRuntimeState: "Running", health: "Healthy", desiredReplicas: 2, cpu: 0.5, memoryBytes: 536870912 };

describe("AppGroupRoute", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/tenants/t1/app-groups/ag1") return json(group);
      if (path === "/api/tenants/t1/app-groups/ag1/single-apps") return json([app]);
      if (path === "/api/tenants/t1/app-groups/ag1/single-apps/app1/runtime-config") return json({ environment: {}, secrets: [] });
      if (path === "/api/tenants/t1/app-groups/ag1/single-apps/app1/http-endpoints") return json([]);
      return json([]);
    }));
  });

  it("renders a routable Application Detail from deep App Group segments", async () => {
    render(<AppGroupRoute tenantId="t1" segments={["ag1", "apps", "app1"]} />);
    expect(await screen.findByRole("heading", { name: "checkout" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /edit application/i }).getAttribute("href")).toBe("/tenants/t1/app-groups/ag1/apps/app1/edit");
    const navigation = screen.getByRole("navigation", { name: "Application sections" });
    expect(within(navigation).getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBe("page");
    expect(within(navigation).getByRole("link", { name: "Health" }).getAttribute("href")).toBe("/tenants/t1/app-groups/ag1/apps/app1/health");
  });

  it("renders the five-step create application wizard on apps/new", async () => {
    render(<AppGroupRoute tenantId="t1" segments={["ag1", "apps", "new"]} />);
    expect(await screen.findByRole("heading", { name: /create application/i })).toBeTruthy();
    const steps = screen.getByRole("list", { name: "Creation steps" });
    for (const label of ["Details", "Volumes", "Config", "Resources", "Review"]) expect(within(steps).getByText(label)).toBeTruthy();
    expect(screen.getByText(/create a workload for commerce/i)).toBeTruthy();
  });
});

it("routes final App Group sections and application edit without placeholder UX", async () => {
  render(<AppGroupRoute tenantId="t1" segments={["ag1", "config"]} />);
  expect(await screen.findByRole("heading", { name: "Configuration" })).toBeTruthy();
  expect(screen.queryByText(/being migrated/i)).toBeNull();
});

it("matches the Penpot application edit details hierarchy", async () => {
  render(<AppGroupRoute tenantId="t1" segments={["ag1", "apps", "app1", "edit"]} />);
  expect(await screen.findByRole("heading", { name: "Edit application details" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "checkout" })).toBeTruthy();
  expect(screen.getByText("ghcr.io/acme/checkout:1")).toBeTruthy();
  expect(screen.getAllByText("Running").length).toBeGreaterThan(0);
  expect(screen.getByRole("button", { name: "Stop application" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Restart application" })).toBeTruthy();
  const navigation = screen.getByRole("navigation", { name: "Application sections" });
  expect(within(navigation).getByRole("link", { name: "Runtime" }).getAttribute("href")).toBe("/tenants/t1/app-groups/ag1/apps/app1/edit/compute");
  expect(within(navigation).getByRole("link", { name: "Configuration" }).getAttribute("href")).toBe("/tenants/t1/app-groups/ag1/apps/app1/edit/configuration");
  expect(screen.getByTestId("application-edit-details-grid").className).toContain("md:grid-cols-2");
  expect(screen.getByRole("button", { name: "Save changes" })).toBeTruthy();
  expect(screen.getByText(/saving creates pending App Group changes/i)).toBeTruthy();
});

it("keeps the application navigation active across nested application routes", async () => {
  render(<AppGroupRoute tenantId="t1" segments={["ag1", "apps", "app1", "edit", "compute"]} />);
  await screen.findByRole("heading", { name: "checkout" });
  const navigation = screen.getByRole("navigation", { name: "Application sections" });
  expect(within(navigation).getByRole("link", { name: "Runtime" }).getAttribute("aria-current")).toBe("page");
  expect(within(navigation).getByRole("link", { name: "Overview" }).getAttribute("href")).toBe("/tenants/t1/app-groups/ag1/apps/app1");
});

it("routes Health separately and keeps the Health tab active", async () => {
  render(<AppGroupRoute tenantId="t1" segments={["ag1", "apps", "app1", "health"]} />);
  await screen.findByRole("heading", { name: "checkout" });
  const navigation = screen.getByRole("navigation", { name: "Application sections" });
  expect(within(navigation).getByRole("link", { name: "Health" }).getAttribute("aria-current")).toBe("page");
});
