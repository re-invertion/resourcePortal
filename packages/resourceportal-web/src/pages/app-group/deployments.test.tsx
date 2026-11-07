import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppGroupDeployments } from "./deployments";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("AppGroupDeployments history states", () => {
  it("paginates long history, filters failures and disables rollback for failed/current versions", async () => {
    const deployments = Array.from({ length: 27 }, (_, i) => ({
      id: `dep${i + 1}`, version: i + 1,
      status: i === 0 ? "Failed" : "Succeeded", note: "Regression history",
    }));
    vi.stubGlobal("fetch", vi.fn(async () => json(deployments)));
    const onReload = vi.fn().mockResolvedValue(undefined);
    render(<AppGroupDeployments tenantId="t1" appGroupId="ag1" onReload={onReload} currentVersion={27}/>);
    await screen.findByText("1–20 of 27");
    expect(screen.getAllByRole("button", { name: "Inspect" })).toHaveLength(20);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("21–27 of 27")).toBeTruthy();
    expect(screen.getByText("Current")).toBeTruthy();
    const current = screen.getByText("Current").closest("tr");
    expect((current?.querySelector('button[disabled]'))).not.toBeNull();
    fireEvent.change(screen.getByLabelText("Filter deployment status"), { target: { value: "Failed" } });
    expect(screen.getAllByRole("button", { name: "Inspect" })).toHaveLength(1);
    expect((screen.getByRole("button", { name: "Rollback" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

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
