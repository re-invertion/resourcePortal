import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppGroupConfig } from "./config";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("AppGroupConfig destructive actions", () => {
  it("confirms in-app before deleting a reusable variable", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/variables") && (!init?.method || init.method === "GET")) return json([{ id: "var1", name: "DATABASE_URL", description: "DB" }]);
      if ((path.endsWith("/secrets") || path.endsWith("/configs")) && (!init?.method || init.method === "GET")) return json([]);
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    const nativeConfirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    render(<AppGroupConfig tenantId="t1" appGroupId="ag1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Delete DATABASE_URL" }));
    expect(screen.getByRole("dialog", { name: "Delete DATABASE_URL?" })).toBeTruthy();
    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([_, init]) => (init as RequestInit | undefined)?.method === "DELETE")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Delete variable" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([path, init]) => String(path).endsWith("/variables/var1") && (init as RequestInit | undefined)?.method === "DELETE")).toBe(true));
  });
});
