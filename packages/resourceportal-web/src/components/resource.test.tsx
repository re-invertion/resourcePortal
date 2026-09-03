import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReadOnlyPanel, ResourcePanel } from "./resource";

describe("permission-aware controls", () => {
  it("hides a create control when known permissions do not include it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("[]", { status: 200, headers: { "content-type": "application/json" } })));
    render(<ResourcePanel title="AppGroups" listPath="/api/tenants/t/app-groups" createPath="/api/tenants/t/app-groups" createPermission="appgroup.create" permissions={["appgroup.read"]} />);
    await screen.findByText("No AppGroups yet.");
    expect(screen.queryByRole("button", { name: "Create one" })).toBeNull();
  });

  it("shows an actionable empty state when creation is allowed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("[]", { status: 200, headers: { "content-type": "application/json" } })));
    render(<ResourcePanel title="AppGroups" listPath="/api/tenants/t/app-groups" createPath="/api/tenants/t/app-groups" createInitialValue={{ name: "" }} createPermission="appgroup.create" permissions={["appgroup.read", "appgroup.create"]} />);

    await screen.findByText("No AppGroups yet.");
    fireEvent.click(screen.getByRole("button", { name: "Create one" }));

    expect(screen.getByRole("button", { name: "Create" })).toBeTruthy();
    expect(screen.getByLabelText("Name")).toBeTruthy();
  });

  it("supports delete-only resources without exposing an edit form", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify([{ id: "ag1", name: "group" }]), { status: 200, headers: { "content-type": "application/json" } })));
    render(<ResourcePanel title="AppGroups" listPath="/api/tenants/t/app-groups" deletePath={(item) => `/api/tenants/t/app-groups/${String(item.id)}`} deletePermission="appgroup.delete" permissions={["appgroup.read", "appgroup.delete"]} />);
    await screen.findByText("group");
    expect(screen.queryByText("Edit")).toBeNull();
    expect(screen.queryByText("Patch")).toBeNull();
  });
});

describe("resource list usability", () => {
  it("filters resources by search text and status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify([
      { id: "ag1", name: "alpha", status: "Running" },
      { id: "ag2", name: "beta", status: "Stopped" },
    ]), { status: 200, headers: { "content-type": "application/json" } })));

    render(<ResourcePanel title="AppGroups" listPath="/api/tenants/t/app-groups" />);
    await screen.findByText("alpha");
    expect(screen.getByText("beta")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Search AppGroups"), { target: { value: "beta" } });
    expect(screen.queryByText("alpha")).toBeNull();
    expect(screen.getByText("beta")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Search AppGroups"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Filter AppGroups by status"), { target: { value: "Running" } });
    expect(screen.getByText("alpha")).toBeTruthy();
    expect(screen.queryByText("beta")).toBeNull();
  });

  it("uses Edit wording for update forms and groups secondary row actions", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify([{ id: "ag1", name: "group" }]), { status: 200, headers: { "content-type": "application/json" } })));
    render(<ResourcePanel title="AppGroups" listPath="/api/tenants/t/app-groups" itemPath={(item) => `/api/tenants/t/app-groups/${String(item.id)}`} updateInitialValue={{ name: "" }} actions={[{ label: "Restart", method: "POST", path: (item) => `/api/tenants/t/app-groups/${String(item.id)}/restart` }]} />);

    const row = await screen.findByRole("row", { name: /group/i });
    expect(within(row).getByText("More actions")).toBeTruthy();
    fireEvent.click(within(row).getByText("More actions"));
    expect(within(row).getByText("Edit")).toBeTruthy();
    expect(within(row).queryByText("Patch")).toBeNull();
    expect(within(row).getByRole("button", { name: "Restart" })).toBeTruthy();
  });

  it("selects a resource by visible row instead of requiring callers to collect its ID", async () => {
    const onSelect = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify([{ id: "app-1", name: "web", status: "Running" }]), { status: 200, headers: { "content-type": "application/json" } })));

    render(<ResourcePanel title="SingleApps" listPath="/api/tenants/t/app-groups/ag1/single-apps" onSelect={onSelect} selectLabel="Configure" />);

    const row = await screen.findByRole("row", { name: /web/i });
    fireEvent.click(within(row).getByRole("button", { name: "Configure" }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "app-1", name: "web" }));
  });

  it("announces a successful resource action", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: "registry-1", name: "registry" }]), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "Valid" }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: "registry-1", name: "registry" }]), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    render(<ResourcePanel title="Registries" listPath="/api/tenants/t/registries" actions={[{ label: "Validate", method: "POST", path: () => "/api/tenants/t/registries/registry-1/validate" }]} />);

    const row = await screen.findByRole("row", { name: /registry/i });
    fireEvent.click(within(row).getByText("More actions"));
    fireEvent.click(within(row).getByRole("button", { name: "Validate" }));

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Validate completed"));
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
