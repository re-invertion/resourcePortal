import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppGroupCreateWizard } from "./app-group-create";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("AppGroupCreateWizard", () => {
  it("reviews a typed draft without mutating and creates only on the final action", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ id: "group-1", name: "shop-production" }, 201));
    vi.stubGlobal("fetch", fetchMock);
    const created = vi.fn();

    render(<AppGroupCreateWizard tenantId="tenant-1" onCancel={vi.fn()} onCreated={created} />);

    expect(screen.getByRole("heading", { name: "Create AppGroup" })).toBeTruthy();
    expect(screen.getByText("Basics")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "shop-production" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Production storefront workloads" } });
    fireEvent.change(screen.getByLabelText("Desired runtime state"), { target: { value: "Running" } });

    fireEvent.click(screen.getByRole("button", { name: "Review + create" }));

    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(screen.getByRole("heading", { name: "Review + create" })).toBeTruthy();
    expect(screen.getByText("shop-production")).toBeTruthy();
    expect(screen.getByText("Production storefront workloads")).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.queryByText(/\{.*name.*\}/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Create AppGroup" }));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [path, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/tenants/tenant-1/app-groups");
    expect(options.method).toBe("POST");
    expect(JSON.parse(String(options.body))).toEqual({
      name: "shop-production",
      description: "Production storefront workloads",
      runtimeState: "Running",
    });
    await vi.waitFor(() => expect(created).toHaveBeenCalledWith("group-1"));
  });

  it("requires a name before review", () => {
    render(<AppGroupCreateWizard tenantId="tenant-1" onCancel={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Review + create" }));
    expect(screen.getByRole("alert").textContent).toContain("Name is required");
  });
});
