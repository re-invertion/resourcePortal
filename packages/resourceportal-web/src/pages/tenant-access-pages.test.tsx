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


it("generates a copyable invitation link instead of claiming to send email", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/memberships")) return json([]);
    if (path.endsWith("/invitations") && (!init?.method || init.method === "GET")) return json([]);
    if (path.endsWith("/invitations") && init?.method === "POST") return json({ id: "inv1", email: "alice@example.com", token: "opaque-token-123456789012345678901234567890" });
    if (path.endsWith("/roles")) return json([{ id: "tenant-admin", name: "Tenant admin" }]);
    if (path.endsWith("/groups")) return json([]);
    if (path.endsWith("/identity-providers")) return json([]);
    if (path.endsWith("/auth-policy")) return json({ allowPlatformLogin: true, allowTenantIdentityProviders: true, requireTenantIdentityProvider: false });
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<TenantAdministrationPage tenantId="t1" />);
  fireEvent.click(await screen.findByRole("button", { name: "Invite user" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "alice@example.com" } });
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "tenant-admin" } });
  fireEvent.click(screen.getByRole("button", { name: "Generate invitation link" }));

  expect(await screen.findByText("Invitation link ready")).toBeTruthy();
  expect(screen.getByText(/\/invitations\/opaque-token-123456789012345678901234567890/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Send invitation" })).toBeNull();
  const createCall = fetchMock.mock.calls.find(([path, init]) => String(path).endsWith("/invitations") && (init as RequestInit | undefined)?.method === "POST");
  expect(JSON.parse(String((createCall?.[1] as RequestInit | undefined)?.body))).toEqual({ email: "alice@example.com", roleIds: ["tenant-admin"] });
});

it("regenerates a pending invitation link and therefore rotates its token", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/memberships")) return json([]);
    if (path.endsWith("/invitations") && (!init?.method || init.method === "GET")) return json([{ id: "inv1", email: "alice@example.com", status: "Pending" }]);
    if (path.endsWith("/invitations/inv1/resend") && init?.method === "POST") return json({ id: "inv1", email: "alice@example.com", token: "rotated-token-123456789012345678901234567890" });
    if (path.endsWith("/roles")) return json([{ id: "tenant-admin", name: "Tenant admin" }]);
    if (path.endsWith("/groups")) return json([]);
    if (path.endsWith("/identity-providers")) return json([]);
    if (path.endsWith("/auth-policy")) return json({ allowPlatformLogin: true, allowTenantIdentityProviders: true, requireTenantIdentityProvider: false });
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<TenantAdministrationPage tenantId="t1" />);
  fireEvent.click(await screen.findByRole("button", { name: "Generate new link" }));

  expect(await screen.findByText(/\/invitations\/rotated-token-123456789012345678901234567890/)).toBeTruthy();
  expect(fetchMock.mock.calls.some(([path, init]) => String(path).endsWith("/invitations/inv1/resend") && (init as RequestInit | undefined)?.method === "POST")).toBe(true);
});
