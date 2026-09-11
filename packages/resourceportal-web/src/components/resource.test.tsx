import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReadableDataView, ReadOnlyPanel, ResourcePanel } from "./resource";

describe("permission-aware controls", () => {
  it("hides a create control when known permissions do not include it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("[]", { status: 200, headers: { "content-type": "application/json" } })));
    render(<ResourcePanel title="AppGroups" listPath="/api/tenants/t/app-groups" createPath="/api/tenants/t/app-groups" createPermission="appgroup.create" permissions={["appgroup.read"]} />);
    await screen.findByText("No AppGroups yet.");
    expect(screen.queryByRole("button", { name: "Create AppGroup" })).toBeNull();
  });

  it("shows an actionable guided empty state when creation is allowed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("[]", { status: 200, headers: { "content-type": "application/json" } })));
    render(<ResourcePanel title="AppGroups" listPath="/api/tenants/t/app-groups" createPath="/api/tenants/t/app-groups" createInitialValue={{ name: "" }} createPermission="appgroup.create" permissions={["appgroup.read", "appgroup.create"]} />);

    await screen.findByText("No AppGroups yet.");
    fireEvent.click(screen.getAllByRole("button", { name: "Create AppGroup" })[0]);

    expect(screen.getByRole("heading", { name: "Create AppGroup" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review + create" })).toBeTruthy();
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
  it("keeps technical identifiers out of inventory columns while retaining them in details", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify([{
      id: "app-1",
      appGroupId: "ag-1",
      name: "web",
      status: "Running",
    }]), { status: 200, headers: { "content-type": "application/json" } })));

    render(<ResourcePanel title="SingleApps" listPath="/api/tenants/t/app-groups/ag-1/single-apps" />);

    const row = await screen.findByRole("row", { name: /web/i });
    expect(screen.queryByRole("columnheader", { name: "ID" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "App group ID" })).toBeNull();
    expect(row.getAttribute("data-resource-id")).toBe("app-1");

    fireEvent.click(within(row).getByRole("button", { name: "View details" }));
    expect(screen.getByText("ID")).toBeTruthy();
    expect(screen.getByText("app-1")).toBeTruthy();
    expect(screen.getByText("App group ID")).toBeTruthy();
    expect(screen.getByText("ag-1")).toBeTruthy();
  });

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

  it("shows explicit resource actions without a disclosure menu", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify([{ id: "ag1", name: "group", runtime: { actualReplicas: 2 } }]), { status: 200, headers: { "content-type": "application/json" } })));
    render(<ResourcePanel title="AppGroups" listPath="/api/tenants/t/app-groups" itemPath={(item) => `/api/tenants/t/app-groups/${String(item.id)}`} updateInitialValue={{ name: "" }} actions={[{ label: "Restart", method: "POST", path: (item) => `/api/tenants/t/app-groups/${String(item.id)}/restart` }]} />);

    const row = await screen.findByRole("row", { name: /group/i });
    expect(within(row).queryByText("More actions")).toBeNull();
    expect(within(row).getByRole("button", { name: "View details" })).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Restart" })).toBeTruthy();

    fireEvent.click(within(row).getByRole("button", { name: "View details" }));
    expect(screen.getByRole("heading", { name: "AppGroup details" })).toBeTruthy();
    expect(screen.getByText("Runtime")).toBeTruthy();
    expect(screen.queryByText("Technical JSON")).toBeNull();
  });

  it("opens editing in a stable workspace and saves through the existing mutation path", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: "ag1", name: "group" }]), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "ag1", name: "renamed" }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: "ag1", name: "renamed" }]), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ResourcePanel title="AppGroups" listPath="/api/tenants/t/app-groups" itemPath={(item) => `/api/tenants/t/app-groups/${String(item.id)}`} updateInitialValue={{ name: "" }} />);

    const row = await screen.findByRole("row", { name: /group/i });
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("heading", { name: "Edit AppGroup" })).toBeTruthy();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("group");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const [url, options] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("/api/tenants/t/app-groups/ag1");
    expect(options.method).toBe("PATCH");
    expect(JSON.parse(String(options.body))).toEqual({ name: "renamed" });
    expect(screen.getByRole("status").textContent).toContain("Changes saved");
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
    expect(within(row).queryByText("More actions")).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "Validate" }));

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Validate completed"));
  });
});

describe("readable data views", () => {
  it("renders read-only object responses as labeled values without raw JSON in the normal view", async () => {
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
    expect(screen.queryByText("Technical JSON")).toBeNull();
  });

  it("renders nested resource details as readable fields", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify([{ id: "ag1", name: "group", status: "Ready", runtime: { actualReplicas: 2, blockers: ["BillingSuspended"] } }]), { status: 200, headers: { "content-type": "application/json" } })));

    render(<ResourcePanel title="AppGroups" listPath="/api/tenants/t/app-groups" />);

    await screen.findByText("Ready", { selector: ".rp-status-pill" });
    expect(screen.queryByText("Runtime")).toBeNull();
    const row = screen.getByRole("row", { name: /group/i });
    fireEvent.click(within(row).getByRole("button", { name: "View details" }));
    expect(screen.getByText("Runtime")).toBeTruthy();
    expect(screen.getByText("Actual replicas")).toBeTruthy();
    expect(screen.getByText("BillingSuspended")).toBeTruthy();
    expect(screen.queryByText("Technical JSON")).toBeNull();
  });

  it("keeps technical JSON available only when a technical surface explicitly requests it", () => {
    render(<ReadableDataView value={{ id: "ag1", nested: { value: 1 } }} technicalJson />);
    expect(screen.getByText("Technical JSON")).toBeTruthy();
  });

  it("keeps text read-only responses in a code block", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("services:\n  web:\n    image: nginx", { status: 200, headers: { "content-type": "text/plain" } })));

    const { container } = render(<ReadOnlyPanel title="Stack preview" path="/api/stack-preview" />);

    await screen.findByText(/services:/);
    expect(container.querySelector("pre")?.textContent).toContain("image: nginx");
  });
});
