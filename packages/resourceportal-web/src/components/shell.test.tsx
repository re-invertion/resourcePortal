import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    expect(screen.getByRole("combobox", { name: "Search resources" })).toBeTruthy();
    expect(screen.getAllByLabelText("Help").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Patryk").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(screen.getByLabelText("ResourcePortal")).toBeTruthy();
  });


  it("searches navigation and live tenant resources as the user types", async () => {
    const json = (value: unknown) => Promise.resolve(new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } }));
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/tenants/tenant-1/app-groups") return json([{ id: "ag1", name: "demo-stack", description: "Demo workspace" }]);
      if (path === "/api/tenants/tenant-1/app-groups/ag1/single-apps") return json([{ id: "app1", name: "checkout-api", image: "ghcr.io/acme/checkout:1" }]);
      if (path === "/api/tenants/tenant-1/volumes") return json([{ id: "v1", name: "orders-data" }]);
      if (path === "/api/tenants/tenant-1/registries") return json([{ id: "r1", name: "ghcr" }]);
      if (path === "/api/tenants/tenant-1/domains") return json([{ id: "d1", hostname: "shop.example.test" }]);
      return json([]);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AppShell user={user} route={tenantRoute()} onLogout={vi.fn()}><p>Content</p></AppShell>);
    const search = screen.getByRole("combobox", { name: "Search resources" });

    fireEvent.focus(search);
    fireEvent.change(search, { target: { value: "checkout" } });

    expect(await screen.findByText("checkout-api")).toBeTruthy();
    expect(screen.getByText("Application in demo-stack")).toBeTruthy();

    fireEvent.change(search, { target: { value: "billing" } });
    await waitFor(() => expect(screen.getByText("Credits, quota and vouchers")).toBeTruthy());

    expect(fetchMock).toHaveBeenCalledWith("/api/tenants/tenant-1/app-groups", expect.any(Object));
  });

  it("opens quick search with Ctrl+K", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("[]", { status: 200, headers: { "content-type": "application/json" } })));
    render(<AppShell user={user} route={tenantRoute()} onLogout={vi.fn()}><p>Content</p></AppShell>);
    const search = screen.getByRole("combobox", { name: "Search resources" });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await waitFor(() => expect(document.activeElement).toBe(search));
    expect(search.getAttribute("aria-expanded")).toBe("true");
  });

  it("matches the Penpot 32px topbar help control", () => {
    render(<AppShell user={user} route={tenantRoute()} onLogout={vi.fn()}><p>Content</p></AppShell>);
    const help = screen.getAllByLabelText("Help").find((element) => element.tagName === "A");
    expect(help?.className).toContain("h-8");
    expect(help?.className).toContain("w-8");
    expect(screen.queryByRole("button", { name: "Notifications" })).toBeNull();
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

  it("renders a clickable tenant hierarchy for grouped resource routes", () => {
    const route: Extract<AppRoute, { kind: "tenant" }> = {
      kind: "tenant",
      tenantId: "tenant-1",
      section: "volumes",
      segments: [],
    };
    render(<AppShell user={user} route={route} onLogout={vi.fn()}><p>Content</p></AppShell>);

    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    const links = within(breadcrumb).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual(["Tenant", "Storage & Networking", "Volumes"]);
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/tenants/tenant-1/overview",
      "/tenants/tenant-1/storage-networking",
      "/tenants/tenant-1/volumes",
    ]);
    expect(links.at(-1)?.getAttribute("aria-current")).toBe("page");
  });

  it("renders dynamic App Group and application names in the clickable hierarchy", async () => {
    const json = (value: unknown) => Promise.resolve(new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/tenants/tenant-1/app-groups/ag1") return json({ id: "ag1", name: "demo-stack" });
      if (path === "/api/tenants/tenant-1/app-groups/ag1/single-apps") return json([{ id: "app1", name: "web" }]);
      return json([]);
    }));

    const route: Extract<AppRoute, { kind: "tenant" }> = {
      kind: "tenant",
      tenantId: "tenant-1",
      section: "app-groups",
      resourceId: "ag1",
      segments: ["ag1", "apps", "app1", "edit", "networking"],
    };
    render(<AppShell user={user} route={route} onLogout={vi.fn()}><p>Content</p></AppShell>);

    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    await waitFor(() => expect(within(breadcrumb).getByRole("link", { name: "demo-stack" })).toBeTruthy());
    await waitFor(() => expect(within(breadcrumb).getByRole("link", { name: "web" })).toBeTruthy());

    expect(within(breadcrumb).getAllByRole("link").map((link) => link.textContent)).toEqual([
      "Tenant",
      "Applications",
      "demo-stack",
      "Apps",
      "web",
      "Edit",
      "Networking",
    ]);
    expect(within(breadcrumb).getByRole("link", { name: "Applications" }).getAttribute("href")).toBe("/tenants/tenant-1/applications");
    expect(within(breadcrumb).getByRole("link", { name: "demo-stack" }).getAttribute("href")).toBe("/tenants/tenant-1/app-groups/ag1");
    expect(within(breadcrumb).getByRole("link", { name: "web" }).getAttribute("href")).toBe("/tenants/tenant-1/app-groups/ag1/apps/app1");
    expect(within(breadcrumb).getByRole("link", { name: "Networking" }).getAttribute("href")).toBe("/tenants/tenant-1/app-groups/ag1/apps/app1/edit/networking");
  });

  it("keeps the active tenant context visible in the topbar", () => {
    render(<AppShell user={user} route={tenantRoute("billing")} onLogout={vi.fn()}><p>Content</p></AppShell>);
    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(breadcrumb).getByRole("link", { name: "Tenant" }).getAttribute("href")).toBe("/tenants/tenant-1/overview");
    expect(within(breadcrumb).getByRole("link", { name: "Billing" }).getAttribute("aria-current")).toBe("page");
  });
});