import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "./shell";
import type { AppRoute } from "../router/router";

const user = { id: "u1", displayName: "Patryk", email: "patryk@example.test" };

function tenantRoute(section = "app-groups"): AppRoute {
  return { kind: "tenant", tenantId: "tenant-1", section };
}

describe("AppShell", () => {
  it("groups tenant navigation around user tasks instead of endpoint names", () => {
    render(<AppShell user={user} route={tenantRoute()} onLogout={vi.fn()}><p>Content</p></AppShell>);

    const nav = screen.getByRole("navigation", { name: "Workspace" });
    for (const label of ["Overview", "Applications", "Storage & Networking", "Billing", "Access", "Activity"]) {
      expect(within(nav).getByText(label)).toBeTruthy();
    }

    expect(within(nav).getByRole("link", { name: "App Groups" }).getAttribute("href")).toBe("/tenants/tenant-1/app-groups");
    expect(within(nav).getByRole("link", { name: "Volumes" }).getAttribute("href")).toBe("/tenants/tenant-1/volumes");
    expect(within(nav).getByRole("link", { name: "Operations" }).getAttribute("href")).toBe("/tenants/tenant-1/operations");
  });

  it("marks the current destination and separates platform administration", () => {
    render(<AppShell user={user} route={tenantRoute("billing")} showPlatformAdmin onLogout={vi.fn()}><p>Content</p></AppShell>);

    expect(screen.getByRole("link", { name: "Billing & quota" }).getAttribute("aria-current")).toBe("page");
    const platform = screen.getByRole("navigation", { name: "Platform administration" });
    expect(within(platform).getByText("Platform Admin")).toBeTruthy();
    expect(within(platform).getByRole("link", { name: "Infrastructure" })).toBeTruthy();
  });


  it("hides platform administration when the signed-in user lacks platform access", () => {
    render(<AppShell user={user} route={tenantRoute()} showPlatformAdmin={false} onLogout={vi.fn()}><p>Content</p></AppShell>);

    expect(screen.queryByRole("navigation", { name: "Platform administration" })).toBeNull();
  });

  it("shows the active tenant context and the signed-in user", () => {
    render(<AppShell user={user} route={tenantRoute()} onLogout={vi.fn()}><p>Content</p></AppShell>);

    expect(screen.getByText("tenant-1")).toBeTruthy();
    expect(screen.getByText("Patryk")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });
});
