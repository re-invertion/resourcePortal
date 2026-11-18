import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TenantAdministrationPage } from "./tenant-access-pages";

const appId = "550e8400-e29b-41d4-a716-446655440000";
const ownerId = "m-owner";
const memberId = "m-member";
const owner = { id: ownerId, userId: "owner", status: "Active",
  user: { email: "owner@example.test", displayName: "Owner" },
  roles: [{ id: "tenant-owner", name: "Owner", permissions: ["*"] }], groups: [] };
const member = { id: memberId, userId: "member", status: "Active",
  user: { email: "alice@example.test", displayName: "Alice" },
  roles: [{ id: "sso-login", name: "SSO Login", permissions: [] }], groups: [] };
const roles = [
  { id: "sso-login", name: "SSO Login", permissions: [] },
  { id: "tenant-admin", name: "Tenant Admin", permissions: ["tenant.read"] },
];
const app = { id: appId, name: "Home Assistant", type: "SPA" };
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });

function fixture() {
  let grants = {
    membershipId: memberId, status: "Active",
    grants: [{ applicationId: appId, applicationName: app.name, enabled: false }],
    nativeGrants: [] as Array<{ clientKey: string; enabled: boolean }>,
  };
  const fetchMock = vi.fn(async (pathInput: RequestInfo | URL, init?: RequestInit) => {
    const path = String(pathInput);
    if (path.endsWith("/memberships/m-member") && init?.method === "PATCH") {
      const body = JSON.parse(String(init.body)) as { oauthApplicationIds: string[]; nativeApplicationKeys: string[] };
      grants = { ...grants,
        grants: [{ applicationId: appId, applicationName: app.name, enabled: body.oauthApplicationIds.includes(appId) }],
        nativeGrants: body.nativeApplicationKeys.map(clientKey => ({ clientKey, enabled: true })) };
      return json({ id: memberId });
    }
    if (path.endsWith("/invitations") && init?.method === "POST") return json({
      email: "alice@example.test", token: "opaque-token-123456789012345678901234567890",
      emailDelivery: { sent: true, attempted: true },
    });
    if (path.endsWith("/memberships")) return json([owner, member]);
    if (path.endsWith("/roles")) return json(roles);
    if (path.endsWith("/oauth-applications")) return json([app]);
    if (path.endsWith("/membership-app-grants")) return json([
      { membershipId: ownerId, status: "Active", grants: [], nativeGrants: [] },
      grants,
    ]);
    if (path.endsWith("/invitations")) return json([]);
    if (path.endsWith("/groups")) return json([]);
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock };
}

describe("#430 single member identity and independent SSO / RP roles", () => {
  it("shows exactly one member row even when both RBAC and SSO app grants exist", async () => {
    fixture();
    render(<TenantAdministrationPage tenantId="t1" userId="owner" />);
    expect(await screen.findByText("Alice")).toBeTruthy();
    expect(screen.getAllByText(/SSO apps: none/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/App Users — OAuth application access/)).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Invitation access type" })).toBeNull();
  });

  it("invites SSO-only Home Assistant user without automatically selecting RP RBAC", async () => {
    const { fetchMock } = fixture();
    render(<TenantAdministrationPage tenantId="t1" userId="owner" />);
    fireEvent.click(await screen.findByRole("button", { name: "Invite user" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Email" }), { target: { value: "alice@example.test" } });
    fireEvent.click(screen.getByRole("checkbox", { name: app.name }));
    fireEvent.click(screen.getByRole("button", { name: "Create invitation" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Confirm invitation" })).getByRole("button", { name: "Send invitation" }));
    expect(await screen.findByText("Invitation sent")).toBeTruthy();
    expect(screen.getByText(/invitations\/opaque-token-123456789012345678901234567890/)).toBeTruthy();
    const call = fetchMock.mock.calls.find(([p, i]) => String(p).endsWith("/invitations") && i?.method === "POST");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      email: "alice@example.test", roleIds: ["sso-login"],
      oauthApplicationIds: [appId], nativeApplicationKeys: [],
    });
  });

  it("composes native RP Web and RP Admin without authorizing RP CLI", async () => {
    const { fetchMock } = fixture();
    render(<TenantAdministrationPage tenantId="t1" userId="owner" />);
    fireEvent.click(await screen.findByRole("button", { name: "Invite user" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Email" }), { target: { value: "alice@example.test" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "ResourcePortal Web" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Tenant Admin" }));
    fireEvent.click(screen.getByRole("button", { name: "Create invitation" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Confirm invitation" })).getByRole("button", { name: "Send invitation" }));
    await screen.findByText("Invitation sent");
    const call = fetchMock.mock.calls.find(([p, i]) => String(p).endsWith("/invitations") && i?.method === "POST");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      email: "alice@example.test", roleIds: ["tenant-admin", "sso-login"],
      oauthApplicationIds: [], nativeApplicationKeys: ["web"],
    });
  });

  it("reconciles app grants, native clients and roles in one confirmed membership PATCH", async () => {
    const { fetchMock } = fixture();
    render(<TenantAdministrationPage tenantId="t1" userId="owner" />);
    const edit = await screen.findAllByRole("button", { name: "Edit access" });
    fireEvent.click(edit[1]);
    expect(screen.getByRole("heading", { name: "Edit access: Alice" })).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Home Assistant" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "ResourcePortal CLI" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Tenant Admin/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save access" }));
    expect(fetchMock.mock.calls.some(([p,i]) => String(p).endsWith("/memberships/m-member") && i?.method === "PATCH")).toBe(false);
    fireEvent.click(within(screen.getByRole("dialog", { name: "Save membership access?" })).getByRole("button", { name: "Save access" }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([p,i]) => String(p).endsWith("/memberships/m-member") && i?.method === "PATCH");
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        roleIds: ["sso-login", "tenant-admin"], status: "Active",
        oauthApplicationIds: [appId], nativeApplicationKeys: ["cli"],
      });
    });
  });
});
