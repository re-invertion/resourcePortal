import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TenantSettingsPage } from "./tenant-settings";

function json(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

describe("TenantSettingsPage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("enables MCP for selected tenant members and preserves the allow-list", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/mcp-settings") && (init?.method ?? "GET") === "PATCH") {
        return json({ enabled: true, accessMode: "SelectedMembers", allowedMembershipIds: ["11111111-1111-4111-8111-111111111111"] });
      }
      if (url.endsWith("/mcp-settings")) {
        return json({
          enabled: false,
          accessMode: "SelectedMembers",
          allowedMembershipIds: [],
          oauth: {
            issuer: "https://auth.example.com",
            scopes: ["openid", "profile", "email", "rp-audience"],
            discoveryAvailable: true,
            dynamicClientRegistrationAvailable: false,
          },
        });
      }
      if (url.endsWith("/memberships")) {
        return json([{ id: "11111111-1111-4111-8111-111111111111", status: "Active", user: { displayName: "Alice Admin", email: "alice@example.com" } }]);
      }
      return json([]);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TenantSettingsPage tenantId="22222222-2222-4222-8222-222222222222" />);

    expect(await screen.findByRole("heading", { name: "Tenant settings" })).toBeTruthy();
    expect(await screen.findByText("https://auth.example.com")).toBeTruthy();
    fireEvent.click(screen.getByText("Enable MCP for this tenant"));
    const member = await screen.findByLabelText("Allow Alice Admin to use MCP");
    fireEvent.click(member);
    fireEvent.click(screen.getByRole("button", { name: "Save tenant settings" }));

    await waitFor(() => {
      const patch = calls.find((call) => call.url.endsWith("/mcp-settings") && call.init?.method === "PATCH");
      expect(patch).toBeTruthy();
      expect(JSON.parse(String(patch?.init?.body))).toEqual({
        enabled: true,
        accessMode: "SelectedMembers",
        allowedMembershipIds: ["11111111-1111-4111-8111-111111111111"],
      });
    });
  });

  it("shows zero-config OpenAI guidance when platform OAuth bootstrap is incomplete", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/mcp-settings")) return json({ enabled: true, accessMode: "AllMembers", allowedMembershipIds: [], oauth: { issuer: "https://auth.example.com", scopes: ["openid"], discoveryAvailable: true, dynamicClientRegistrationAvailable: false } });
      return json([]);
    }));
    render(<TenantSettingsPage tenantId="22222222-2222-4222-8222-222222222222" />);
    expect(await screen.findByText("Platform OAuth bootstrap is incomplete")).toBeTruthy();
    expect(screen.getByText(/tenant users should not create a manual OAuth client/i)).toBeTruthy();
    expect(screen.getByText("http://localhost:3000/api/tenants/22222222-2222-4222-8222-222222222222/mcp")).toBeTruthy();
  });

  it("shows OpenAI ready status and no-client-secret guidance when DCR is advertised", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/mcp-settings")) return json({
        enabled: true,
        accessMode: "AllMembers",
        allowedMembershipIds: [],
        oauth: {
          issuer: "https://auth.example.com",
          scopes: ["openid", "profile", "email", "offline_access", "rp-audience"],
          discoveryAvailable: true,
          dynamicClientRegistrationAvailable: true,
          openAiReady: true,
          transport: "Streamable HTTP",
          protocol: "MCP 2026-07-28 with 2025-era compatibility",
        },
      });
      return json([]);
    }));
    render(<TenantSettingsPage tenantId="22222222-2222-4222-8222-222222222222" />);
    expect(await screen.findByText("OpenAI / ChatGPT ready")).toBeTruthy();
    expect(screen.getByText("No Client ID or secret required")).toBeTruthy();
    expect(screen.getByText(/OpenAI\/ChatGPT can register its OAuth client/i)).toBeTruthy();
    expect(screen.getByText("offline_access", { exact: false })).toBeTruthy();
  });

});
