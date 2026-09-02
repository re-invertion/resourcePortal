import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ResourcePanel } from "./resource";

describe("permission-aware controls", () => {
  it("hides a create control when known permissions do not include it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("[]", { status: 200, headers: { "content-type": "application/json" } })));
    render(<ResourcePanel title="AppGroups" listPath="/api/tenants/t/app-groups" createPath="/api/tenants/t/app-groups" createPermission="appgroup.create" permissions={["appgroup.read"]} />);
    await screen.findByText("No resources.");
    expect(screen.queryByRole("button", { name: "Create" })).toBeNull();
  });

  it("shows the create control when permission is present", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("[]", { status: 200, headers: { "content-type": "application/json" } })));
    render(<ResourcePanel title="AppGroups" listPath="/api/tenants/t/app-groups" createPath="/api/tenants/t/app-groups" createPermission="appgroup.create" permissions={["appgroup.read", "appgroup.create"]} />);
    await screen.findByText("No resources.");
    expect(screen.getByRole("button", { name: "Create" })).toBeTruthy();
  });

  it("supports delete-only resources without exposing a patch form", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify([{ id: "ag1", name: "group" }]), { status: 200, headers: { "content-type": "application/json" } })));
    render(<ResourcePanel title="AppGroups" listPath="/api/tenants/t/app-groups" deletePath={(item) => `/api/tenants/t/app-groups/${String(item.id)}`} deletePermission="appgroup.delete" permissions={["appgroup.read", "appgroup.delete"]} />);
    await screen.findByRole("button", { name: "Delete" });
    expect(screen.queryByText("Patch")).toBeNull();
  });
});