import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppGroupDeployments, deploymentInDateRange, deploymentRollbackReason, deploymentSafePreview, deploymentSafeDiff, invalidDeploymentTimeRange } from "./deployments";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("#399 §13 secret-safe deployment preview and diff", () => {
  it("shows only allowlisted workload fields and compares without leaking sensitive data", () => {
    const old = deploymentSafePreview({ stackConfig: { singleApps: [{ id: "a", name: "api", image: "app:v1", desiredReplicas: 1, runtimeState: "Running", environment: { TOKEN: "secret-should-not-leak" }, configs: [{ content: "private" }] }] } });
    const next = deploymentSafePreview({ stackConfig: { singleApps: [{ id: "a", name: "api", image: "app:v2", desiredReplicas: 2, runtimeState: "Stopped", environment: { TOKEN: "another-secret" } }] } });
    expect(JSON.stringify(next)).not.toContain("secret");
    expect(JSON.stringify(next)).not.toContain("TOKEN");
    expect(deploymentSafeDiff(old, next)).toEqual([{ id: "a", label: "api", change: "Changed: image, replicas, runtime" }]);
    expect(deploymentSafePreview({})).toEqual([]);
    expect(deploymentSafeDiff([], next)).toEqual([{ id: "a", label: "api", change: "Added" }]);
  });
});

describe("AppGroupDeployments history states", () => {
  it("refreshes the authoritative App Group version when a running deployment finishes", async () => {
    let latestStatus = "Running";
    const fetchMock = vi.fn(async () => json([
      { id: "dep-1", version: 1, status: "Succeeded" },
      { id: "dep-2", version: 2, status: latestStatus },
    ]));
    vi.stubGlobal("fetch", fetchMock);
    const onReload = vi.fn().mockResolvedValue(undefined);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const { rerender, unmount } = render(<AppGroupDeployments
        tenantId="t1" appGroupId="ag1" onReload={onReload} currentVersion={1}/>);
      await screen.findByRole("row", { name: /v2 Running/i });
      expect(onReload).not.toHaveBeenCalled();
      expect(within(screen.getByText("v1").closest("tr")!).getByText("Current")).toBeTruthy();

      latestStatus = "Succeeded";
      await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
      await waitFor(() => expect(onReload).toHaveBeenCalledTimes(1));
      rerender(<AppGroupDeployments tenantId="t1" appGroupId="ag1"
        onReload={onReload} currentVersion={2}/>);
      const newCurrent = screen.getByText("v2").closest("tr");
      expect(within(newCurrent!).getByText("Current")).toBeTruthy();
      expect((within(newCurrent!).getByRole("button", { name: "Rollback" }) as HTMLButtonElement).disabled).toBe(true);
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(onReload).toHaveBeenCalledTimes(1);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

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

describe("#399 deployment time filters and rollback blockers", () => {
  it("uses inclusive local time bounds and hides rows missing a timestamp only when filters apply", () => {
    const localBound = new Date(2026, 9, 10, 11, 0);
    const old = { createdAt: new Date(localBound.getTime() - 3600000).toISOString() };
    const same = { createdAt: localBound.toISOString() };
    const newer = { createdAt: new Date(localBound.getTime() + 3600000).toISOString() };
    expect(deploymentInDateRange(old, "2026-10-10T11:00", "")).toBe(false);
    expect(deploymentInDateRange(same, "2026-10-10T11:00", "2026-10-10T11:00")).toBe(true);
    expect(deploymentInDateRange(newer, "", "2026-10-10T11:00")).toBe(false);
    expect(deploymentInDateRange({}, "", "")).toBe(true);
    expect(deploymentInDateRange({}, "2026-10-10T11:00", "")).toBe(false);
  });

  it("explains which rollback selections are unsupported", () => {
    expect(deploymentRollbackReason({ status: "Failed", version: 1 }, 2, false)).toMatch(/successful/);
    expect(deploymentRollbackReason({ status: "Succeeded", version: 2 }, 2, false)).toMatch(/already current/);
    expect(deploymentRollbackReason({ status: "Succeeded", version: 1 }, 2, true)).toMatch(/Wait/);
    expect(deploymentRollbackReason({ status: "Succeeded", version: 1 }, 2, false)).toBe("");
  });

  it("filters rendered history by updated range without changing deployments", async () => {
    const localBound = new Date(2026, 9, 10, 11, 0);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json([
      { id: "dep-old", version: 1, status: "Failed", createdAt: new Date(localBound.getTime() - 3600000).toISOString() },
      { id: "dep-new", version: 2, status: "Succeeded", createdAt: new Date(localBound.getTime() + 3600000).toISOString() },
    ]));
    vi.stubGlobal("fetch", fetchMock);
    render(<AppGroupDeployments tenantId="t1" appGroupId="ag1" onReload={vi.fn().mockResolvedValue(undefined)} currentVersion={2}/>);
    expect(await screen.findByText("v1")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Deployments from"), { target: { value: "2026-10-10T11:00" } });
    expect(screen.queryByText("v1")).toBeNull();
    expect(screen.getByText("v2")).toBeTruthy();
    expect(screen.getByText("This deployment is already current.")).toBeTruthy();
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });
});

describe("#399 deployment history filter safety", () => {
  it("detects reversed deployment time ranges without involving the API", () => {
    expect(invalidDeploymentTimeRange("2026-10-10T12:00","2026-10-10T11:00")).toBe(true);
    expect(invalidDeploymentTimeRange("2026-10-10T11:00","2026-10-10T11:00")).toBe(false);
    expect(invalidDeploymentTimeRange("","2026-10-10T11:00")).toBe(false);
  });

  it("shows bounded history counts, refuses inverted date filters and restores the list on clear", async () => {
    const fetchMock=vi.fn(async (_url:RequestInfo|URL,_init?:RequestInit)=>json([
      {id:"d1",version:1,status:"Succeeded",note:"previous",createdAt:"2026-10-10T10:00:00Z"},
      {id:"d2",version:2,status:"Succeeded",note:"current",createdAt:"2026-10-10T11:00:00Z"},
    ]));
    vi.stubGlobal("fetch",fetchMock);
    render(<AppGroupDeployments tenantId="t1" appGroupId="ag1" onReload={vi.fn().mockResolvedValue(undefined)} currentVersion={2}/>);
    expect(await screen.findByText("v1")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Showing 2 of 2 deployments");
    expect((screen.getByRole("button",{name:"Clear deployment filters"}) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Deployments from"),{target:{value:"2026-10-10T12:00"}});
    fireEvent.change(screen.getByLabelText("Deployments to"),{target:{value:"2026-10-10T11:00"}});
    expect(screen.getByRole("alert").textContent).toMatch(/earlier than or equal/i);
    expect(screen.queryByText("v1")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Showing 0 of 2 deployments");
    fireEvent.click(screen.getByRole("button",{name:"Clear deployment filters"}));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("v1")).toBeTruthy();
    expect(screen.getByText("v2")).toBeTruthy();
    expect((screen.getByRole("button",{name:"Clear deployment filters"}) as HTMLButtonElement).disabled).toBe(true);
    expect(fetchMock.mock.calls.every(([url,init])=>(String(url).includes("/api/tenants/t1/app-groups/ag1/")||String(url).includes("/api/tenants/t1/domains"))&&(!init?.method||init.method==="GET"))).toBe(true);
  });
});
