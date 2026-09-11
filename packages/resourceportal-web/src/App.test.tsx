import { fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("Web Console bootstrap", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    history.replaceState(null, "", "/tenants");
  });

  it("renders on the server without browser location globals", () => {
    vi.stubGlobal("location", undefined);
    try {
      expect(() => renderToString(<App initialPath="/tenants/t1/app-groups" />)).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("renders controlled re-login when the BFF session is missing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ error: { message: "Unauthorized" } }, 401)));
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
  });

  it("shows tenant selection for multiple active tenants", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ id: "u1", email: "u@example.test", displayName: "User", status: "Active" }))
      .mockResolvedValueOnce(json([{ id: "t1", name: "one", status: "Active" }, { id: "t2", name: "two", status: "Active" }]));
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Choose tenant" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /one/ }).getAttribute("href")).toContain("/tenants/t1/overview");
    expect(screen.getByRole("link", { name: /two/ }).getAttribute("href")).toContain("/tenants/t2/overview");
  });

  it("renders a normal document link for the only active tenant", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ id: "u1", email: "u@example.test", displayName: "User", status: "Active" }))
      .mockResolvedValueOnce(json([{ id: "t1", name: "one", status: "Active" }]));
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Tenant" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /one/ }).getAttribute("href")).toBe("/tenants/t1/overview");
  });

  it("exposes every required CreateTenantDto field and reviews the structured tenant payload before creation", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ id: "u1", email: "u@example.test", displayName: "User", status: "Active" }))
      .mockResolvedValueOnce(json([]))
      .mockResolvedValueOnce(json({ id: "t1", name: "demo", displayName: "Demo tenant", contactEmail: "owner@example.test", status: "Active" }, 201))
      .mockResolvedValueOnce(json([{ id: "t1", name: "demo", displayName: "Demo tenant", status: "Active" }]));
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    await screen.findByRole("heading", { name: "Choose tenant" });
    expect(screen.getByRole("heading", { name: "Create Tenant" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "demo" } });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Demo tenant" } });
    fireEvent.change(screen.getByLabelText("Contact email"), { target: { value: "owner@example.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Review + create" }));

    expect(screen.getByRole("heading", { name: "Review configuration" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Create Tenant" }));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    const [, options] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(JSON.parse(String(options.body))).toEqual({
      name: "demo",
      displayName: "Demo tenant",
      contactEmail: "owner@example.test",
    });
  });

  it("uses semantic tenant navigation icons and exposes breadcrumbs in authenticated workspace routes", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/auth/me") return json({ id: "u1", email: "u@example.test", displayName: "User", status: "Active" });
      if (path === "/api/tenants") return json([{ id: "t1", name: "one", displayName: "Production", status: "Active" }]);
      if (path === "/api/platform/maintenance") return json({ error: { message: "Forbidden" } }, 403);
      if (path === "/api/tenants/t1/memberships") return json([]);
      if (path === "/api/tenants/t1/app-groups") return json([]);
      return json({ error: { message: `Unexpected ${path}` } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App initialPath="/tenants/t1/app-groups" />);

    await screen.findByRole("heading", { name: "AppGroups" });
    const appGroupsLink = screen.getByRole("link", { name: "App Groups" });
    expect(appGroupsLink.querySelector('[data-rp-icon="app-group"]')).not.toBeNull();
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeTruthy();
  });

  it("shows Platform Admin navigation only after the protected capability probe succeeds", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/auth/me") return json({ id: "u1", email: "u@example.test", displayName: "User", status: "Active" });
      if (path === "/api/tenants") return json([{ id: "t1", name: "one", status: "Active" }]);
      if (path === "/api/platform/maintenance") return json({ enabled: false });
      if (path === "/api/tenants/t1/memberships") return json([]);
      if (path === "/api/tenants/t1") return json({ id: "t1", name: "one", status: "Active" });
      if (path === "/api/tenants/t1/app-groups") return json([]);
      if (path === "/api/tenants/t1/billing") return json({ balanceCredits: "100", balancePln: "1", billingState: "Active", lowBalance: false });
      if (path === "/api/tenants/t1/volumes") return json([]);
      if (path === "/api/tenants/t1/operations") return json([]);
      return json({ error: { message: `Unexpected ${path}` } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App initialPath="/tenants/t1/overview" />);

    expect(await screen.findByRole("heading", { name: "one" })).toBeTruthy();
    expect(await screen.findByRole("navigation", { name: "Platform administration" })).toBeTruthy();
  });

  it("keeps Platform Admin navigation hidden when the protected capability probe is denied", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/auth/me") return json({ id: "u1", email: "u@example.test", displayName: "User", status: "Active" });
      if (path === "/api/tenants") return json([{ id: "t1", name: "one", status: "Active" }]);
      if (path === "/api/platform/maintenance") return json({ error: { message: "Forbidden" } }, 403);
      if (path === "/api/tenants/t1/memberships") return json([]);
      if (path === "/api/tenants/t1") return json({ id: "t1", name: "one", status: "Active" });
      if (path === "/api/tenants/t1/app-groups") return json([]);
      if (path === "/api/tenants/t1/billing") return json({ balanceCredits: "100", balancePln: "1", billingState: "Active", lowBalance: false });
      if (path === "/api/tenants/t1/volumes") return json([]);
      if (path === "/api/tenants/t1/operations") return json([]);
      return json({ error: { message: `Unexpected ${path}` } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App initialPath="/tenants/t1/overview" />);

    expect(await screen.findByRole("heading", { name: "one" })).toBeTruthy();
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([path]) => String(path) === "/api/platform/maintenance")).toBe(true));
    expect(screen.queryByRole("navigation", { name: "Platform administration" })).toBeNull();
  });

  it("keeps an authenticated unknown document route on a not-found view", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ id: "u1", email: "u@example.test", displayName: "User", status: "Active" }))
      .mockResolvedValueOnce(json([{ id: "t1", name: "one", status: "Active" }]));
    vi.stubGlobal("fetch", fetchMock);
    render(<App initialPath="/definitely-not-a-resource-portal-route" />);

    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Tenant" })).toBeNull();
  });
});
