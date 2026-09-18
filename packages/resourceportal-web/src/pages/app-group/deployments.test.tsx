import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppGroupDeployments } from "./deployments";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("AppGroupDeployments destructive actions", () => {
  it("confirms before rolling back to a previous deployment", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/deployments") && (!init?.method || init.method === "GET")) {
        return json([{ id: "dep1", version: 7, status: "Succeeded", note: "Stable" }]);
      }
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    const onReload = vi.fn().mockResolvedValue(undefined);

    render(<AppGroupDeployments tenantId="t1" appGroupId="ag1" onReload={onReload} />);

    const rollback = await screen.findByRole("button", { name: "Rollback" });
    fireEvent.click(rollback);
    expect(screen.getByRole("dialog", { name: "Rollback deployment v7?" })).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([_, init]) => (init as RequestInit | undefined)?.method === "POST")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Rollback to v7" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([path, init]) => String(path).endsWith("/deployments/dep1/rollback") && (init as RequestInit | undefined)?.method === "POST")).toBe(true));
  });
});
