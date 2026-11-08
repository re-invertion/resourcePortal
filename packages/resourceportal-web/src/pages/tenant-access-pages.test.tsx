import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TenantAdministrationPage } from "./tenant-access-pages";

const ownerMembership = { id: "owner-id", userId: "owner", status: "Active", user: {displayName:"Owner",email:"owner@example.com"}, roles: [{id:"tenant-owner",name:"Owner",permissions:["*"]}], groups: [] };
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("TenantAdministrationPage destructive actions", () => {
  it("confirms in-app before revoking an invitation", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/memberships")) return json([ownerMembership]);
      if (path.endsWith("/invitations") && (!init?.method || init.method === "GET")) return json([{ id: "inv1", email: "alice@example.com", status: "Pending" }]);
      if (path.endsWith("/roles")) return json([{ id: "role1", name: "TenantAdmin", displayName: "Tenant admin" }]);
      if (path.endsWith("/groups")) return json([]);
      if (path.endsWith("/identity-providers")) return json([]);
      if (path.endsWith("/auth-policy")) return json({ allowPlatformLogin: true, allowTenantIdentityProviders: true, requireTenantIdentityProvider: false });
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    const nativeConfirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    render(<TenantAdministrationPage tenantId="t1" userId="owner" />);

    fireEvent.click(await screen.findByRole("button", { name: "Delete invitation alice@example.com" }));
    expect(screen.getByRole("dialog", { name: "Revoke invitation for alice@example.com?" })).toBeTruthy();
    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([_, init]) => (init as RequestInit | undefined)?.method === "DELETE")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Revoke invitation" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([path, init]) => String(path).endsWith("/invitations/inv1") && (init as RequestInit | undefined)?.method === "DELETE")).toBe(true));
  });
});


it("shows successful SMTP delivery and keeps a copyable invitation link", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/memberships")) return json([ownerMembership]);
    if (path.endsWith("/invitations") && (!init?.method || init.method === "GET")) return json([]);
    if (path.endsWith("/invitations") && init?.method === "POST") return json({ id: "inv1", email: "alice@example.com", token: "opaque-token-123456789012345678901234567890", emailDelivery: { attempted: true, sent: true } });
    if (path.endsWith("/roles")) return json([{ id: "tenant-admin", name: "Tenant admin" }]);
    if (path.endsWith("/groups")) return json([]);
    if (path.endsWith("/identity-providers")) return json([]);
    if (path.endsWith("/auth-policy")) return json({ allowPlatformLogin: true, allowTenantIdentityProviders: true, requireTenantIdentityProvider: false });
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<TenantAdministrationPage tenantId="t1" userId="owner" />);
  fireEvent.click(await screen.findByRole("button", { name: "Invite user" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "alice@example.com" } });
  fireEvent.change(screen.getByRole("combobox", { name: "ResourcePortal role" }), { target: { value: "tenant-admin" } });
  fireEvent.click(screen.getByRole("button", { name: "Create invitation" }));
  expect(screen.getByText("Confirm invitation")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));

  expect(await screen.findByText("Invitation sent")).toBeTruthy();
  expect(screen.getByText("Invitation email was sent.")).toBeTruthy();
  expect(screen.getByText(/\/invitations\/opaque-token-123456789012345678901234567890/)).toBeTruthy();
  const createCall = fetchMock.mock.calls.find(([path, init]) => String(path).endsWith("/invitations") && (init as RequestInit | undefined)?.method === "POST");
  expect(JSON.parse(String((createCall?.[1] as RequestInit | undefined)?.body))).toEqual({ email: "alice@example.com", roleIds: ["tenant-admin"] });
});

it("invites App User with explicitly selected OAuth client and zero ResourcePortal roles", async () => {
  const appId = "550e8400-e29b-41d4-a716-446655440000";
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/memberships")) return json([ownerMembership]);
    if (path.endsWith("/invitations") && (!init?.method || init.method === "GET")) return json([]);
    if (path.endsWith("/invitations") && init?.method === "POST") return json({
      id: "inv-app-1", email: "alice@example.com",
      token: "opaque-token-123456789012345678901234567890",
      emailDelivery: { attempted: false, sent: false },
    });
    if (path.endsWith("/oauth-applications")) return json([{ id: appId, name: "Home Assistant", type: "SPA" }]);
    if (path.endsWith("/roles")) return json([{ id: "tenant-admin", name: "Tenant admin" }]);
    if (path.endsWith("/groups")) return json([]);
    if (path.endsWith("/app-consumers")) return json([]);
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<TenantAdministrationPage tenantId="t1" userId="owner" />);

  fireEvent.click(await screen.findByRole("button", { name: "Invite user" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "alice@example.com" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Invitation access type" }),
    { target: { value: "AppUser" } });
  const appCheck = await screen.findByRole("checkbox", { name: "Home Assistant" });
  expect(screen.queryByRole("combobox", { name: "ResourcePortal role" })).toBeNull();
  expect((screen.getByRole("button", { name: "Create invitation" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(appCheck);
  fireEvent.click(screen.getByRole("button", { name: "Create invitation" }));
  expect(screen.getByText("Confirm invitation")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
  expect(await screen.findByText("Invitation link ready")).toBeTruthy();
  const call = fetchMock.mock.calls.find(([path, init]) =>
    String(path).endsWith("/invitations") && (init as RequestInit | undefined)?.method === "POST");
  expect(JSON.parse(String((call?.[1] as RequestInit | undefined)?.body))).toEqual({
    email: "alice@example.com", roleIds: [], oauthApplicationIds: [appId],
  });
});

it("requires confirmation for client-specific grants and revokes without RP roles", async () => {
  const appId = "550e8400-e29b-41d4-a716-446655440000";
  const memberId = "660e8400-e29b-41d4-a716-446655440000";
  let enabled = false;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/memberships")) return json([ownerMembership]);
    if (path.endsWith("/oauth-applications")) return json([{ id: appId, name: "Home Assistant" }]);
    if (path.endsWith("/app-consumers") && (!init?.method || init.method === "GET")) return json([{
      membershipId: memberId, status: "Active", user: {
        id: "consumer-1", email: "alice@example.com", displayName: "Alice", status: "Active",
      }, grants: [{ applicationId: appId, applicationName: "Home Assistant", enabled }],
    }]);
    if (path.endsWith("/app-consumers/" + memberId + "/grants") && init?.method === "POST") {
      enabled = true;
      return json({ applicationId: appId, enabled: true });
    }
    if (path.endsWith("/app-consumers/" + memberId + "/grants/" + appId) && init?.method === "DELETE") {
      enabled = false;
      return json({ applicationId: appId, enabled: false });
    }
    if (path.endsWith("/roles")) return json([{ id: "tenant-owner", name: "Owner" }]);
    if (path.endsWith("/invitations") || path.endsWith("/groups")) return json([]);
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<TenantAdministrationPage tenantId="t1" userId="owner" />);
  const grantButton = await screen.findByRole("button", { name: "Home Assistant: Denied" });
  fireEvent.click(grantButton);
  expect(enabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Grant client access" }));
  expect(await screen.findByRole("button", { name: "Home Assistant: Allowed" })).toBeTruthy();
  expect(fetchMock.mock.calls.some(([path, init]) =>
    String(path).endsWith("/app-consumers/" + memberId + "/grants") && (init as RequestInit | undefined)?.method === "POST"
  )).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Home Assistant: Allowed" }));
  fireEvent.click(screen.getByRole("button", { name: "Revoke client access" }));
  expect(await screen.findByRole("button", { name: "Home Assistant: Denied" })).toBeTruthy();
});

it("regenerates a pending invitation link and therefore rotates its token", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/memberships")) return json([ownerMembership]);
    if (path.endsWith("/invitations") && (!init?.method || init.method === "GET")) return json([{ id: "inv1", email: "alice@example.com", status: "Pending" }]);
    if (path.endsWith("/invitations/inv1/resend") && init?.method === "POST") return json({ id: "inv1", email: "alice@example.com", token: "rotated-token-123456789012345678901234567890" });
    if (path.endsWith("/roles")) return json([{ id: "tenant-admin", name: "Tenant admin" }]);
    if (path.endsWith("/groups")) return json([]);
    if (path.endsWith("/identity-providers")) return json([]);
    if (path.endsWith("/auth-policy")) return json({ allowPlatformLogin: true, allowTenantIdentityProviders: true, requireTenantIdentityProvider: false });
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<TenantAdministrationPage tenantId="t1" userId="owner" />);
  fireEvent.click(await screen.findByRole("button", { name: "Generate new link" }));

  expect(await screen.findByText(/\/invitations\/rotated-token-123456789012345678901234567890/)).toBeTruthy();
  expect(fetchMock.mock.calls.some(([path, init]) => String(path).endsWith("/invitations/inv1/resend") && (init as RequestInit | undefined)?.method === "POST")).toBe(true);
});

it("groups daily Access navigation and hides legacy login migration policy", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json([])));
  render(<TenantAdministrationPage tenantId="t1" userId="owner" />);
  expect(await screen.findByRole("link", { name: "Members & invitations" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Roles & groups" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Integrations" })).toBeTruthy();
  expect(screen.queryByText("Advanced: native login migration policy")).toBeNull();
  expect(screen.getByRole("link", { name: "Open tenant Identity & SSO" })).toBeTruthy();
});
