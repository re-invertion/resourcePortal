import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppGroupNetworking } from "./networking";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("AppGroupNetworking destructive actions", () => {
  it("confirms in-app before deleting an endpoint", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/single-apps") && (!init?.method || init.method === "GET")) return json([{ id: "app1", name: "web" }]);
      if (path.endsWith("/single-apps/app1/http-endpoints") && (!init?.method || init.method === "GET")) return json([{ id: "ep1", name: "public", containerPort: 8080, protocolMode: "HTTP" }]);
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    const nativeConfirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    render(<AppGroupNetworking tenantId="t1" appGroupId="ag1" />);

    const deleteButton = await screen.findByRole("button", { name: "Delete public" });
    await waitFor(() => expect(fetchMock.mock.calls.filter(([path, init]) => String(path).endsWith("/single-apps") && (!(init as RequestInit | undefined)?.method || (init as RequestInit).method === "GET"))).toHaveLength(1));
    fireEvent.click(deleteButton);
    expect(screen.getByRole("dialog", { name: "Delete endpoint public?" })).toBeTruthy();
    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([_, init]) => (init as RequestInit | undefined)?.method === "DELETE")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Delete endpoint" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([path, init]) => String(path).endsWith("/single-apps/app1/http-endpoints/ep1") && (init as RequestInit | undefined)?.method === "DELETE")).toBe(true));
  });
});
