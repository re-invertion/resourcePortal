import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("Web Console bootstrap", () => {
  beforeEach(() => {
    history.replaceState(null, "", "/tenants");
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

  it("enters the only active tenant automatically", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ id: "u1", email: "u@example.test", displayName: "User", status: "Active" }))
      .mockResolvedValueOnce(json([{ id: "t1", name: "one", status: "Active" }]))
      .mockResolvedValueOnce(json({ id: "t1", name: "one", status: "Active" }))
      .mockResolvedValueOnce(json([]));
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    await waitFor(() => expect(location.pathname).toBe("/tenants/t1/overview"));
    expect(await screen.findByRole("heading", { level: 1, name: "Tenant overview" })).toBeTruthy();
  });
});
