import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "../api/client";
import { useApi } from "./use-api";

vi.mock("../api/client", () => ({ apiRequest: vi.fn() }));
const request = vi.mocked(apiRequest);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useApi latest-response-wins (#260)", () => {
  afterEach(() => request.mockReset());

  it("does not overwrite a post-mutation reload with an older in-flight GET", async () => {
    const old = deferred<{ id: string }[]>();
    const current = deferred<{ id: string }[]>();
    request.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const hook = renderHook(() => useApi<{ id: string }[]>("/api/tenants/t1/volumes"));
    await act(async () => {
      const reload = hook.result.current.reload();
      current.resolve([{ id: "created" }]);
      await reload;
    });
    expect(hook.result.current.data).toEqual([{ id: "created" }]);
    await act(async () => { old.resolve([]); await old.promise; });
    expect(hook.result.current.data).toEqual([{ id: "created" }]);
    expect(hook.result.current.loading).toBe(false);
  });

  it("ignores old successes and failures after the resource path changes", async () => {
    const old = deferred<string[]>();
    request.mockReturnValueOnce(old.promise).mockResolvedValueOnce(["new-tenant"]);
    const hook = renderHook(({ path }) => useApi<string[]>(path), {
      initialProps: { path: "/api/tenants/old/volumes" },
    });
    hook.rerender({ path: "/api/tenants/new/volumes" });
    await waitFor(() => expect(hook.result.current.data).toEqual(["new-tenant"]));
    await act(async () => { old.reject(new Error("old failure")); try { await old.promise; } catch { /* expected */ } });
    expect(hook.result.current.error).toBeUndefined();
    expect(hook.result.current.data).toEqual(["new-tenant"]);
  });

  it("does not let an old failed reload replace the latest successful one", async () => {
    const old = deferred<string[]>();
    request.mockReturnValueOnce(old.promise).mockResolvedValueOnce(["updated"]);
    const hook = renderHook(() => useApi<string[]>("/api/tenants/t1/apps"));
    await act(async () => { await hook.result.current.reload(); });
    await waitFor(() => expect(hook.result.current.data).toEqual(["updated"]));
    await act(async () => { old.reject(new Error("old failure")); try { await old.promise; } catch { /* expected */ } });
    expect(hook.result.current.error).toBeUndefined();
    expect(hook.result.current.loading).toBe(false);
  });
});
