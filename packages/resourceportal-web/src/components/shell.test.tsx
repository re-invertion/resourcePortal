import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "./shell";
import type { AppRoute } from "../router/router";

const user = { id: "u1", displayName: "Patryk", email: "patryk@example.test" };

function tenantRoute(section = "applications"): Extract<AppRoute, { kind: "tenant" }> {
  return { kind: "tenant", tenantId: "tenant-1", section, segments: [] };
}

describe("AppShell", () => {
  it("matches the final Penpot tenant navigation hierarchy", () => {
    render(<AppShell user={user} route={tenantRoute()} onLogout={vi.fn()}><p>Content</p></AppShell>);
    const nav = screen.getByRole("navigation", { name: "Workspace" });
    for (const label of ["Overview", "Applications", "Storage & Networking", "Billing", "Access", "Activity"]) expect(within(nav).getByRole("link", { name: label })).toBeTruthy();
    expect(within(nav).getByRole("link", { name: "Applications" }).getAttribute("href")).toBe("/tenants/tenant-1/applications");
    expect(within(nav).getByRole("link", { name: "Applications" }).getAttribute("aria-current")).toBe("page");
  });

  it("provides the final topbar controls and user menu", () => {
    render(<AppShell user={user} route={tenantRoute()} onLogout={vi.fn()}><p>Content</p></AppShell>);
    expect(screen.getByRole("textbox", { name: "Search resources" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Notifications" })).toBeTruthy();
    expect(screen.getAllByLabelText("Help").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Patryk").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(screen.getByLabelText("ResourcePortal")).toBeTruthy();
  });

  it("matches the Penpot 32px topbar icon controls", () => {
    render(<AppShell user={user} route={tenantRoute()} onLogout={vi.fn()}><p>Content</p></AppShell>);
    const notifications = screen.getByRole("button", { name: "Notifications" });
    const help = screen.getAllByLabelText("Help").find((element) => element.tagName === "A");
    expect(notifications.className).toContain("h-8");
    expect(notifications.className).toContain("w-8");
    expect(help?.className).toContain("h-8");
    expect(help?.className).toContain("w-8");
  });

  it("shows Platform Admin only when platform access is available", () => {
    const { rerender } = render(<AppShell user={user} route={tenantRoute()} showPlatformAdmin={false} onLogout={vi.fn()}><p>Content</p></AppShell>);
    expect(screen.queryByRole("navigation", { name: "Platform administration" })).toBeNull();
    rerender(<AppShell user={user} route={tenantRoute()} showPlatformAdmin onLogout={vi.fn()}><p>Content</p></AppShell>);
    expect(within(screen.getByRole("navigation", { name: "Platform administration" })).getByRole("link", { name: "Platform Admin" })).toBeTruthy();
  });

  it("matches the final Platform Admin navigation hierarchy", () => {
    const route: Extract<AppRoute, { kind: "platform" }> = { kind: "platform", section: "security", segments: [] };
    render(<AppShell user={user} route={route} onLogout={vi.fn()}><p>Content</p></AppShell>);
    const nav = screen.getByRole("navigation", { name: "Workspace" });
    for (const label of ["Overview", "Tenants", "Infrastructure", "Identity providers", "Credentials", "Billing", "Security & Ops", "Maintenance"]) {
      expect(within(nav).getByRole("link", { name: label })).toBeTruthy();
    }
    expect(within(nav).getByRole("link", { name: "Security & Ops" }).getAttribute("href")).toBe("/platform/security");
    expect(within(nav).getByRole("link", { name: "Security & Ops" }).getAttribute("aria-current")).toBe("page");
  });

  it("keeps the active tenant context visible in the topbar", () => {
    render(<AppShell user={user} route={tenantRoute("billing")} onLogout={vi.fn()}><p>Content</p></AppShell>);
    expect(screen.getByText("Tenant / Billing")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Billing" }).getAttribute("aria-current")).toBe("page");
  });
});