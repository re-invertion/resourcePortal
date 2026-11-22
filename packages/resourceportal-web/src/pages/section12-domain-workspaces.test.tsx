import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TenantDomainsPage, TenantDomainDetailPage } from "./tenant-storage-pages";
import { AppGroupNetworking } from "./app-group/networking";
import { NetworkingTabs } from "../components/tenant-section-tabs";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

describe("#399 §12 domains, roots, and canonical endpoint relations", () => {
  it("exposes a dedicated root-domains workspace with tenant-owned verification and integration", async () => {
    window.history.replaceState({}, "", "/tenants/t1/domains?view=roots");
    const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/domains/custom-root-domains")) return json([
        { id: "root-1", rootDomain: "example.com", verificationMethod: "DNS_TXT", verificationStatus: "Pending", verificationToken: "verification-only" },
      ]);
      if (url.endsWith("/domains/cloudflare/status")) return json({ connected: false, configured: true });
      if (url.endsWith("/domains/capabilities")) return json({ managedDomains: { enabled: false } });
      return json([]);
    });
    vi.stubGlobal("fetch", fetcher);
    render(<TenantDomainsPage tenantId="t1" />);
    expect(await screen.findByRole("heading", { name: "Root domains", level: 1 })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Root domains" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByText("verification-only")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Validate" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Domains & routing" })).toBeNull();
    expect(fetcher.mock.calls.every(([, init]) => !init || !(init as RequestInit).method || (init as RequestInit).method === "GET")).toBe(true);
  });

  it("restores the root workspace after Cloudflare OAuth callback without losing verification access", async () => {
    window.history.replaceState({}, "", "/tenants/t1/domains?cloudflare=connected");
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/domains/cloudflare/zones")) return json([{ id: "zone1", name: "example.com" }]);
      if (path.endsWith("/domains/custom-root-domains")) return json([
        { id: "root1", rootDomain: "example.com", verificationStatus: "Verified", verificationMethod: "CLOUDFLARE_OAUTH" },
      ]);
      if (path.endsWith("/domains/cloudflare/status")) return json({ configured: true, connected: true });
      if (path.endsWith("/domains/capabilities")) return json({ managedDomains: { enabled: false } });
      return json([]);
    });
    vi.stubGlobal("fetch", fetcher);
    render(<TenantDomainsPage tenantId="t1" />);
    expect(await screen.findByRole("heading", { name: "Root domains", level: 1 })).toBeTruthy();
    expect(window.location.search).toBe("?view=roots");
    expect(await screen.findByRole("dialog", { name: "Add root domain using Cloudflare" })).toBeTruthy();
    expect(screen.getAllByText("example.com").length).toBeGreaterThan(0);
    expect(screen.queryByRole("heading", { name: "Domains & routing" })).toBeNull();
  });

  it("keeps domain routing and root ownership in separate tenant navigation links", () => {
    render(<NetworkingTabs tenantId="t1" active="domains" />);
    expect(screen.getByRole("link", { name: "Domains" }).getAttribute("href")).toBe("/tenants/t1/domains");
    expect(screen.getByRole("link", { name: "Root domains" }).getAttribute("href")).toBe("/tenants/t1/domains?view=roots");
  });

  it("can explicitly reassign an already assigned domain from its own detail", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/domains/d1")) return json({
        id: "d1", hostname: "site.example.com", dnsStatus: "Valid", type: "Managed",
        httpEndpoint: { id: "old", name: "old", appGroupId: "ag1", singleAppId: "app1" },
        publication: { eligible: true },
      });
      if (url.endsWith("/app-groups")) return json([{ id: "ag1", name: "Group" }]);
      if (url.endsWith("/domains/custom-root-domains")) return json([]);
      if (url.endsWith("/domains/d1/dns-diagnostics")) return json({});
      if (url.endsWith("/domains/d1/certificate/diagnostics")) return json({});
      return json([]);
    }));
    render(<TenantDomainDetailPage tenantId="t1" domainId="d1" />);
    expect(await screen.findByRole("heading", { name: "Assign to an application" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Edit endpoint" }).getAttribute("href")).toBe("/tenants/t1/app-groups/ag1/apps/app1/edit/networking");
  });

  it("assigns a verified tenant-domain inventory entry to an endpoint only after confirmation", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/single-apps")) return json([{ id: "app1", name: "web" }]);
      if (url.endsWith("/single-apps/app1/http-endpoints")) return json([
        { id: "ep1", name: "front", containerPort: 8080, protocolMode: "HTTP_REDIRECT_TO_HTTPS" },
      ]);
      if (url.endsWith("/domains") && (!init?.method || init.method === "GET")) return json([
        { id: "d1", hostname: "www.example.com", tenantId: "t1", dnsStatus: "Valid" },
        { id: "foreign", hostname: "private.other.example", tenantId: "t2" },
      ]);
      if (url.endsWith("/networking/topology")) return json({ appGroups: [], networks: [], gates: [] });
      if (url.endsWith("/networking/lan-attachments")) return json([]);
      if (url.endsWith("/domains/d1") && init?.method === "PATCH") return json({ id: "d1" });
      return json([]);
    });
    vi.stubGlobal("fetch", fetcher);
    render(<AppGroupNetworking tenantId="t1" appGroupId="ag1" />);
    const domain = await screen.findByRole("combobox", { name: "Tenant domain to assign" });
    await waitFor(() => expect(within(domain).getByRole("option", { name: "www.example.com" })).toBeTruthy());
    expect(within(domain).queryByRole("option", { name: "private.other.example" })).toBeNull();
    fireEvent.change(domain, { target: { value: "d1" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Target HTTP endpoint" }), { target: { value: "ep1" } });
    fireEvent.click(screen.getByRole("button", { name: "Assign domain" }));
    expect(screen.getByRole("dialog", { name: "Confirm endpoint domain assignment" })).toBeTruthy();
    expect(fetcher.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "PATCH")).toHaveLength(0);
    fireEvent.click(within(screen.getByRole("dialog", { name: "Confirm endpoint domain assignment" })).getByRole("button", { name: "Assign domain to endpoint" }));
    await waitFor(() => expect(fetcher.mock.calls.some(([url, init]) =>
      String(url) === "/api/tenants/t1/domains/d1" &&
      (init as RequestInit | undefined)?.method === "PATCH" &&
      String((init as RequestInit).body).includes("ep1"),
    )).toBe(true));
  });
});
