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

  it("shows OAuth discovery and DCR safety guidance", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/mcp-settings")) return json({ enabled: true, accessMode: "AllMembers", allowedMembershipIds: [], oauth: { issuer: "https://auth.example.com", scopes: ["openid"], discoveryAvailable: true, dynamicClientRegistrationAvailable: false } });
      return json([]);
    }));
    render(<TenantSettingsPage tenantId="22222222-2222-4222-8222-222222222222" />);
    expect(await screen.findByText("Automatic OAuth client registration is not advertised")).toBeTruthy();
    expect(screen.getByText(/same ResourcePortal identity system/i)).toBeTruthy();
    expect(screen.getByText("http://localhost:3000/api/tenants/22222222-2222-4222-8222-222222222222/mcp")).toBeTruthy();
  });
});
