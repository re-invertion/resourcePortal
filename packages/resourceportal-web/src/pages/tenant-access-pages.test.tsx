import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TenantAdministrationPage } from "./tenant-access-pages";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("TenantAdministrationPage destructive actions", () => {
  it("confirms in-app before revoking an invitation", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/memberships")) return json([]);
      if (path.endsWith("/invitations") && (!init?.method || init.method === "GET")) return json([{ id: "inv1", email: "alice@example.com", status: "Pending" }]);
      if (path.endsWith("/roles")) return json([{ id: "role1", name: "TenantAdmin", displayName: "Tenant admin" }]);
      if (path.endsWith("/groups")) return json([]);
      if (path.endsWith("/identity-providers")) return json([]);
      if (path.endsWith("/auth-policy")) return json({ allowPlatformLogin: true, allowTenantIdentityProviders: true, requireTenantIdentityProvider: false });
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    const nativeConfirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    render(<TenantAdministrationPage tenantId="t1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Delete invitation alice@example.com" }));
    expect(screen.getByRole("dialog", { name: "Revoke invitation for alice@example.com?" })).toBeTruthy();
    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([_, init]) => (init as RequestInit | undefined)?.method === "DELETE")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Revoke invitation" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([path, init]) => String(path).endsWith("/invitations/inv1") && (init as RequestInit | undefined)?.method === "DELETE")).toBe(true));
  });
});
