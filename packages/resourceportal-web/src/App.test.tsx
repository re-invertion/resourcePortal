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

  it("exposes every required CreateTenantDto field and submits the structured tenant payload", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ id: "u1", email: "u@example.test", displayName: "User", status: "Active" }))
      .mockResolvedValueOnce(json([]))
      .mockResolvedValueOnce(json({ id: "t1", name: "demo", displayName: "Demo tenant", contactEmail: "owner@example.test", status: "Active" }, 201))
      .mockResolvedValueOnce(json([{ id: "t1", name: "demo", displayName: "Demo tenant", status: "Active" }]));
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    await screen.findByRole("heading", { name: "Choose tenant" });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "demo" } });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Demo tenant" } });
    fireEvent.change(screen.getByLabelText("Contact email"), { target: { value: "owner@example.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Create tenant" }));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    const [, options] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(JSON.parse(String(options.body))).toEqual({
      name: "demo",
      displayName: "Demo tenant",
      contactEmail: "owner@example.test",
    });
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