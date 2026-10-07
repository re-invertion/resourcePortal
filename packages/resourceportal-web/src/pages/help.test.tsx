import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TenantHelpPage } from "./help";

describe("TenantHelpPage", () => {
  it("documents common tenant-user operations and links to the current tenant", () => {
    render(<TenantHelpPage tenantId="tenant-1" />);

    expect(screen.getByRole("heading", { name: "Help & getting started", level: 1 })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "How ResourcePortal is organized" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Create and deploy an application" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Import an App Group from YAML" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Use a private container registry" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Add persistent storage" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Add a domain to an application" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Credits, usage and vouchers" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Troubleshoot a failed operation" })).toBeTruthy();

    expect(screen.getAllByRole("link", { name: "Open Applications" })[0]?.getAttribute("href")).toBe("/tenants/tenant-1/applications");
    expect(screen.getAllByRole("link", { name: "Create App Group" })[0]?.getAttribute("href")).toBe("/tenants/tenant-1/applications/new");
    expect(screen.getByRole("link", { name: "Open Domains" }).getAttribute("href")).toBe("/tenants/tenant-1/domains");
    expect(screen.getByRole("link", { name: "Open Volumes" }).getAttribute("href")).toBe("/tenants/tenant-1/volumes");
    expect(screen.getByRole("link", { name: "Open Billing" }).getAttribute("href")).toBe("/tenants/tenant-1/billing");
    expect(screen.getAllByRole("link", { name: "Open Activity" })[0]?.getAttribute("href")).toBe("/tenants/tenant-1/activity");
  });

  it("provides a table of contents linked to the documentation sections", () => {
    render(<TenantHelpPage tenantId="tenant-1" />);

    const tables = screen.getAllByRole("navigation", { name: "Help topics" });
    expect(tables.length).toBeGreaterThanOrEqual(1);

    const toc = tables[0];
    expect(within(toc).getByRole("link", { name: "Getting started" }).getAttribute("href")).toBe("#getting-started");
    expect(within(toc).getByRole("link", { name: "Create an application" }).getAttribute("href")).toBe("#create-application");
    expect(within(toc).getByRole("link", { name: "Import from YAML" }).getAttribute("href")).toBe("#app-group-yaml");
    expect(within(toc).getByRole("link", { name: "Private Networks & VPN" }).getAttribute("href")).toBe("#private-networking");
    expect(within(toc).getByRole("link", { name: "Domains & HTTP routing" }).getAttribute("href")).toBe("#domain");
    expect(within(toc).getByRole("link", { name: "Billing & vouchers" }).getAttribute("href")).toBe("#billing");
    expect(within(toc).getByRole("link", { name: "Troubleshooting" }).getAttribute("href")).toBe("#troubleshooting");

    expect(document.getElementById("getting-started")).toBeTruthy();
    expect(document.getElementById("app-group-yaml")).toBeTruthy();
    expect(document.getElementById("domain")).toBeTruthy();
    expect(document.getElementById("troubleshooting")).toBeTruthy();
  });

  it("scrolls directly to a section when the Help URL contains a hash", async () => {
    const scrollIntoView = vi.fn();
    const originalScroll = HTMLElement.prototype.scrollIntoView;
    const originalRaf = window.requestAnimationFrame;
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    Object.defineProperty(window, "requestAnimationFrame", {
      configurable: true,
      value: (callback: FrameRequestCallback) => { callback(0); return 1; },
    });
    window.history.replaceState({}, "", "#billing");

    try {
      render(<TenantHelpPage tenantId="tenant-1" />);
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    } finally {
      window.history.replaceState({}, "", window.location.pathname);
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: originalScroll });
      Object.defineProperty(window, "requestAnimationFrame", { configurable: true, value: originalRaf });
    }
  });

  it("adds explanatory context instead of only listing steps", () => {
    render(<TenantHelpPage tenantId="tenant-1" />);

    expect(screen.getByText(/Most work in ResourcePortal follows the same sequence/i)).toBeTruthy();
    expect(screen.getByText(/A Tenant is your isolated workspace/i)).toBeTruthy();
    expect(screen.getAllByText(/resourceportal.io\/v1alpha1/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Use persistent storage for files the application must keep/i)).toBeTruthy();
    expect(screen.getByText(/Transactions record changes to the balance/i)).toBeTruthy();
    expect(screen.getByText(/The public System status page describes the health of ResourcePortal itself/i)).toBeTruthy();
  });

  it("stays focused on tenant-user help instead of platform administration", () => {
    const { container } = render(<TenantHelpPage tenantId="tenant-1" />);
    const text = container.textContent ?? "";

    expect(text).not.toContain("Maintenance");
    expect(text).not.toContain("Storage backends");
    expect(text).not.toContain("Price lists");
    expect(text).not.toContain("Credit adjustment");
    expect(text).toContain("tenant users");
  });
});