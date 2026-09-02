import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReadOnlyPanel, ResourcePanel } from "./resource";

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

describe("readable data views", () => {
  it("renders read-only object responses as labeled values with a technical JSON fallback", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      health: "Healthy",
      maintenance: false,
      capacity: { totalBytes: "1000" },
    }), { status: 200, headers: { "content-type": "application/json" } })));

    render(<ReadOnlyPanel title="Storage backend" path="/api/platform/storage-backends/backend-1" />);

    expect(await screen.findByText("Health")).toBeTruthy();
    expect(screen.getByText("Healthy")).toBeTruthy();
    expect(screen.getByText("Maintenance")).toBeTruthy();
    expect(screen.getByText("No")).toBeTruthy();
    expect(screen.getByText("Capacity")).toBeTruthy();
    expect(screen.getByText("Total bytes")).toBeTruthy();
    expect(screen.getByText("Technical JSON")).toBeTruthy();
  });

  it("renders nested resource details as readable fields", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify([{ id: "ag1", name: "group", status: "Ready", runtime: { actualReplicas: 2, blockers: ["BillingSuspended"] } }]), { status: 200, headers: { "content-type": "application/json" } })));

    render(<ResourcePanel title="AppGroups" listPath="/api/tenants/t/app-groups" />);

    await screen.findByText("Ready");
    expect(screen.getByText("Runtime")).toBeTruthy();
    expect(screen.getByText("Actual replicas")).toBeTruthy();
    expect(screen.getByText("BillingSuspended")).toBeTruthy();
    expect(screen.getByText("Technical JSON")).toBeTruthy();
  });

  it("keeps text read-only responses in a code block", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("services:\n  web:\n    image: nginx", { status: 200, headers: { "content-type": "text/plain" } })));

    const { container } = render(<ReadOnlyPanel title="Stack preview" path="/api/stack-preview" />);

    await screen.findByText(/services:/);
    expect(container.querySelector("pre")?.textContent).toContain("image: nginx");
  });
});
