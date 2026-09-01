import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ResourcePanel } from "./resource";

describe("permission-aware controls", () => {
  it("hides a create control when known permissions do not include it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("[]", { status: 200, headers: { "content-type": "application/json" } })));
    render(<ResourcePanel title="AppGroups" listPath="/api/tenants/t/app-groups" createPath="/api/tenants/t/app-groups" createPermission="app_group.create" permissions={["app_group.read"]} />);
    await screen.findByText("No resources.");
    expect(screen.queryByRole("button", { name: "Create" })).toBeNull();
  });

  it("shows the create control when permission is present", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("[]", { status: 200, headers: { "content-type": "application/json" } })));
    render(<ResourcePanel title="AppGroups" listPath="/api/tenants/t/app-groups" createPath="/api/tenants/t/app-groups" createPermission="app_group.create" permissions={["app_group.read", "app_group.create"]} />);
    await screen.findByText("No resources.");
    expect(screen.getByRole("button", { name: "Create" })).toBeTruthy();
  });
});
