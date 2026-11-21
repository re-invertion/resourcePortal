import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { groupEffectivePermissions, TenantAdministrationPage } from "./tenant-access-pages";

const json = (value: unknown) => new Response(JSON.stringify(value), {
  status: 200, headers: { "content-type": "application/json" },
});
const group = {
  id: "group-a", tenantId: "tenant-a", name: "Engineering", description: "Deploy team",
  roles: [
    { id: "reader", name: "Reader", permissions: ["tenant.read", "group.read"] },
    { id: "editor", name: "Editor", permissions: ["group.read", "group.update"] },
  ],
  members: [{ id: "member-a", userId: "member-a", user: { displayName: "Alice" } }],
};
function fixture({ viewer = false, failAudit = false } = {}) {
  const actor = { id: "owner", userId: "owner", status: "Active",
    roles: [{ id: "owner-role", name: "Owner", permissions: viewer ? ["tenant.read"] : ["*"] }], groups: [] };
  const auditRows = [
    { id: "audit-a", resourceType: "TenantGroup", resourceId: "group-a",
      action: "tenant_group.role.assign", result: "Success", actorName: "Owner", timestamp: "2026-11-20T12:00:00Z" },
    { id: "audit-foreign", resourceType: "TenantGroup", resourceId: "group-b",
      action: "tenant_group.delete", result: "Success", actorName: "Foreign", timestamp: "2026-11-20T12:00:00Z" },
    { id: "audit-other-type", resourceType: "AppGroup", resourceId: "group-a",
      action: "appgroup.deploy", result: "Success", actorName: "Other", timestamp: "2026-11-20T12:00:00Z" },
  ];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.includes("/audit-log?")) {
      if (failAudit) throw new Error("Audit temporarily unavailable");
      return json(auditRows);
    }
    if (path.endsWith("/memberships")) return json([actor]);
    if (path.endsWith("/groups")) return json([group]);
    if (path.endsWith("/roles")) return json(group.roles);
    if (path.endsWith("/invitations")) return json([]);
    if (path.endsWith("/oauth-applications")) return json([]);
    if (path.endsWith("/membership-app-grants")) return json([]);
    throw new Error("Unexpected request " + path + " " + (init?.method ?? "GET"));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
afterEach(() => vi.unstubAllGlobals());

describe("#399 tenant group details and verified activity", () => {
  it("deduplicates inherited role permissions and retains wildcard semantics", () => {
    expect(groupEffectivePermissions(group)).toEqual(["group.read", "group.update", "tenant.read"]);
    expect(groupEffectivePermissions({ roles: [{ permissions: ["*", "tenant.read"] }] })).toEqual(["*"]);
    expect(groupEffectivePermissions({ roles: [{ permissions: [42, null] }] })).toEqual([]);
  });

  it("opens details from the group name and strictly excludes other tenant resource activity", async () => {
    const fetchMock = fixture();
    render(<TenantAdministrationPage tenantId="tenant-a" userId="owner" />);
    fireEvent.click(await screen.findByRole("button", { name: "Open group Engineering details" }));
    const detail = await screen.findByRole("heading", { name: "Group: Engineering" });
    expect(detail).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Members (1)" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Inherited roles (2)" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Effective permissions inherited through this group" })).toBeTruthy();
    expect(screen.getByText(/Deleting this group removes these inherited grants from 1 member/)).toBeTruthy();
    const activity = screen.getByRole("region", { name: "Group activity" });
    await within(activity).findByText("tenant group.role.assign");
    expect(within(activity).getByText(/2026/)).toBeTruthy();
    expect(within(activity).queryByText("tenant group.delete")).toBeNull();
    expect(within(activity).queryByText("appgroup.deploy")).toBeNull();
    await waitFor(() => {
      const auditCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/audit-log?"));
      expect(String(auditCall?.[0])).toBe("/api/tenants/tenant-a/audit-log?resourceType=TenantGroup&resourceId=group-a&limit=100");
    });
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });

  it("lets read-only users inspect group details but does not offer group mutations", async () => {
    fixture({ viewer: true });
    render(<TenantAdministrationPage tenantId="tenant-a" userId="owner" />);
    fireEvent.click(await screen.findByRole("button", { name: "Open group Engineering details" }));
    expect(await screen.findByRole("heading", { name: "Group: Engineering" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save group" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
  });

  it("reports audit loading failures instead of implying no group activity exists", async () => {
    fixture({ failAudit: true });
    render(<TenantAdministrationPage tenantId="tenant-a" userId="owner" />);
    fireEvent.click(await screen.findByRole("button", { name: "Open group Engineering details" }));
    expect(await screen.findByRole("alert", { name: "" })).toBeTruthy();
    expect(screen.getByText(/Could not load group activity/)).toBeTruthy();
    expect(screen.queryByText("No group activity in this page")).toBeNull();
  });
});
