import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ResourcePanel } from "./resource";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("cloud-style resource creation", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("guides the user from basics through review before creating a resource", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json([]))
      .mockResolvedValueOnce(json({ id: "v1", name: "data", sizeGiB: 20 }, 201))
      .mockResolvedValueOnce(json([{ id: "v1", name: "data", sizeGiB: 20 }]));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ResourcePanel
        title="Volumes"
        listPath="/api/tenants/t1/volumes"
        createPath="/api/tenants/t1/volumes"
        createInitialValue={{ name: "", sizeGiB: 20 }}
      />,
    );

    expect(await screen.findByText("No Volumes yet.")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Create volume" })[0]);

    expect(screen.getByRole("heading", { name: "Create Volume" })).toBeTruthy();
    expect(screen.getByText("Basics")).toBeTruthy();
    expect(screen.getAllByText("Review + create").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/persistent storage/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/No changes are applied until/i)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "data" } });
    fireEvent.click(screen.getByRole("button", { name: "Review + create" }));

    expect(screen.getByRole("heading", { name: "Review configuration" })).toBeTruthy();
    expect(screen.getByText("data")).toBeTruthy();
    expect(screen.getByText("20")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Create volume" }));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const [url, options] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("/api/tenants/t1/volumes");
    expect(options.method).toBe("POST");
    expect(JSON.parse(String(options.body))).toEqual({ name: "data", sizeGiB: 20 });
    expect(await screen.findByText("Volumes created.")).toBeTruthy();
  });
});
