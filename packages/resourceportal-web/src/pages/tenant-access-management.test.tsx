import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TenantAdministrationPage, mayManageAccess } from "./tenant-access-pages";

const owner = {
  id: "m-owner", userId: "user-owner", status: "Active",
  user: { displayName: "Tenant Owner", email: "owner@example.com" },
  roles: [{ id: "tenant-owner", name: "Owner", permissions: ["*"] }], groups: [],
};
const viewer = {
  id: "m-viewer", userId: "user-viewer", status: "Active",
  user: { displayName: "Read Only", email: "read@example.com" },
  roles: [{ id: "tenant-viewer", name: "Viewer", permissions: ["membership.read", "group.read"] }], groups: [],
};
const member = {
  id: "m-member", userId: "user-member", status: "Active",
  user: { displayName: "Member", email: "member@example.com" },
  roles: [{ id: "tenant-viewer", name: "Viewer", permissions: ["tenant.read"] }], groups: [],
};
const roleList = [
  { id: "tenant-owner", name: "Owner", permissions: ["*"] },
  { id: "tenant-viewer", name: "Viewer", permissions: ["tenant.read"] },
  { id: "tenant-admin", name: "Admin", permissions: ["membership.update", "group.member.manage"] },
];
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
function fetcher() {
  let activeGroup = {
    id: "g-admin", name: "Developers", description: "App team",
    members: [{ ...member, id: "m-member" }], roles: [{ id: "tenant-viewer", name: "Viewer", permissions: ["tenant.read"] }],
  };
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); calls.push({ url, init });
    if (url.endsWith("/memberships") && (!init?.method || init.method === "GET")) return json([owner, viewer, member]);
    if (url.endsWith("/memberships/m-member") && init?.method === "PATCH") return json({ success: true });
    if (url.endsWith("/roles")) return json(roleList);
    if (url.endsWith("/invitations")) return json([]);
    if (url.endsWith("/groups") && (!init?.method || init.method === "GET")) return json([activeGroup]);
    if (url.endsWith("/groups/g-admin/members") && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      activeGroup = { ...activeGroup, members: [...activeGroup.members, { ...viewer, id: body.membershipId }] };
      return json({ success: true });
    }
    if (url.endsWith("/groups/g-admin/roles") && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      const role = roleList.find(r => r.id === body.roleId)!;
      activeGroup = { ...activeGroup, roles: [...activeGroup.roles, role] };
      return json({ success: true });
    }
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

describe("Tenant Access: role boundaries and connected controls", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fails closed for suspended users, absent memberships and ordinary viewers", () => {
    expect(mayManageAccess(undefined, "membership.update")).toBe(false);
    expect(mayManageAccess({ ...owner, status: "Suspended" }, "membership.update")).toBe(false);
    expect(mayManageAccess(viewer, "membership.update")).toBe(false);
    expect(mayManageAccess(viewer, "membership.read")).toBe(true);
    expect(mayManageAccess(owner, "membership.update")).toBe(true);
    expect(mayManageAccess({ ...viewer, groups: [{ roles: roleList.slice(2) }] }, "group.member.manage")).toBe(true);
  });

  it("hides mutators for a Viewer, without treating Viewer as application-only access", async () => {
    const calls = fetcher();
    render(<TenantAdministrationPage tenantId="tenant-a" userId="user-viewer" />);
    expect(await screen.findByText("Read Only")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Invite user" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit access" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Create group" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Manage" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete Developers" })).toBeNull();
    expect(screen.getByText(/Granting a role gives ResourcePortal rights/)).toBeTruthy();
    expect(calls.some(c => c.init?.method === "POST" || c.init?.method === "PATCH")).toBe(false);
  });

  it("edits a member's direct role and status through PATCH only after confirmation", async () => {
    const calls = fetcher();
    render(<TenantAdministrationPage tenantId="tenant-a" userId="user-owner" />);
    const edit = await screen.findAllByRole("button", { name: "Edit access" });
    fireEvent.click(edit[2]);
    expect(screen.getByRole("heading", { name: "Edit access: Member" })).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /Admin/ }));
    fireEvent.change(screen.getByRole("combobox", { name: "Membership status" }), { target: { value: "Suspended" } });
    fireEvent.click(screen.getByRole("button", { name: "Save access" }));
    expect(calls.some(c => c.init?.method === "PATCH")).toBe(false);
    fireEvent.click(within(screen.getByRole("dialog", { name: "Save membership access?" })).getByRole("button", { name: "Save access" }));
    await waitFor(() => {
      const change = calls.find(c => c.url.endsWith("/memberships/m-member") && c.init?.method === "PATCH");
      expect(change).toBeTruthy();
      expect(JSON.parse(String(change?.init?.body))).toEqual({ roleIds: ["tenant-viewer", "tenant-admin"], status: "Suspended" });
    });
  });

  it("adds group members and inherited roles through real tenant-scoped API operations", async () => {
    const calls = fetcher();
    render(<TenantAdministrationPage tenantId="tenant-a" userId="user-owner" />);
    fireEvent.click(await screen.findByRole("button", { name: "Manage" }));
    expect(screen.getByRole("heading", { name: "Group: Developers" })).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Select group member" }), { target: { value: "m-viewer" } });
    const memberSelector = screen.getByRole("combobox", { name: "Select group member" });
    fireEvent.click(memberSelector.parentElement!.querySelector("button")!);
    await waitFor(() => expect(calls.some(c => c.url.endsWith("/groups/g-admin/members") && c.init?.method === "POST" && JSON.parse(String(c.init.body)).membershipId === "m-viewer")).toBe(true));
    fireEvent.change(screen.getByRole("combobox", { name: "Select group role" }), { target: { value: "tenant-admin" } });
    const roleSelector = screen.getByRole("combobox", { name: "Select group role" });
    fireEvent.click(roleSelector.parentElement!.querySelector("button")!);
    await waitFor(() => expect(calls.some(c => c.url.endsWith("/groups/g-admin/roles") && c.init?.method === "POST" && JSON.parse(String(c.init.body)).roleId === "tenant-admin")).toBe(true));
  });
});

it("removes group-inherited admin controls after revocation and refreshes member projection", async () => {
  let groupRoleEnabled = true;
  let groupMemberEnabled = true;
  let membershipsReads = 0;
  const baseGroup = { id: "g-dev", name: "Developers", description: "",
    members: [{ ...viewer, id: "m-operator" }], roles: [{ id: "r-manage", name: "Manager",
      permissions: ["group.role.manage", "group.member.manage"] }] };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); const method = init?.method ?? "GET";
    if (url.endsWith("/memberships") && method === "GET") {
      membershipsReads++;
      return json([{ ...viewer, userId: "operator", id: "m-operator",
        groups: groupRoleEnabled ? [{ id: "g-dev", name: "Developers",
          roles: [{ id: "r-manage", name: "Manager", permissions: ["group.role.manage", "group.member.manage"] }] }] : [] }]);
    }
    if (url.endsWith("/groups") && method === "GET") return json([{
      ...baseGroup, members: groupMemberEnabled ? baseGroup.members : [],
      roles: groupRoleEnabled ? baseGroup.roles : [],
    }]);
    if (url.endsWith("/groups/g-dev/roles/r-manage") && method === "DELETE") {
      groupRoleEnabled = false;
      return json({ success: true });
    }
    if (url.endsWith("/roles")) return json(roleList.concat(baseGroup.roles));
    if (url.endsWith("/invitations")) return json([]);
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<TenantAdministrationPage tenantId="t1" userId="operator" />);
  fireEvent.click(await screen.findByRole("button", { name: "Manage" }));
  expect(screen.getByText(/inherited: Manager/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove role Manager from Developers" }));
  const confirmation = await screen.findByRole("dialog", { name: "Remove Manager from group?" });
  fireEvent.click(within(confirmation).getByRole("button", { name: "Remove role" }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([url,init]) =>
    String(url).endsWith("/groups/g-dev/roles/r-manage") && init?.method === "DELETE")).toBe(true));
  await waitFor(() => {
    expect(membershipsReads).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/inherited: Manager/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Manage" })).toBeNull();
  });
  expect(screen.getByText(/Granting a role gives ResourcePortal rights/)).toBeTruthy();
});

it("refreshes memberships after group deletion so inherited permissions do not remain visible", async () => {
  let groupPresent = true;
  let membershipReads = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); const method = init?.method ?? "GET";
    if (url.endsWith("/memberships") && method === "GET") {
      membershipReads++;
      return json([
        { ...owner, groups: groupPresent ? [{ id: "g-dev", name: "Developers",
          roles: [{ id: "tenant-admin", name: "Admin", permissions: ["membership.update"] }] }] : [] },
        viewer,
      ]);
    }
    if (url.endsWith("/groups") && method === "GET") return json(groupPresent ? [{
      id: "g-dev", name: "Developers", description: "", members: [], roles: [{ id: "tenant-admin", name: "Admin", permissions: ["membership.update"] }],
    }] : []);
    if (url.endsWith("/groups/g-dev") && method === "DELETE") {
      groupPresent = false;
      return json({ deleted: true });
    }
    if (url.endsWith("/roles")) return json(roleList);
    if (url.endsWith("/invitations")) return json([]);
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<TenantAdministrationPage tenantId="t1" userId="user-owner" />);
  expect(await screen.findByText(/inherited: Admin/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Delete Developers" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Delete group Developers?" }))
    .getByRole("button", { name: "Delete group" }));
  await waitFor(() => expect(groupPresent).toBe(false));
  await waitFor(() => {
    expect(membershipReads).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/inherited: Admin/)).toBeNull();
  });
});
