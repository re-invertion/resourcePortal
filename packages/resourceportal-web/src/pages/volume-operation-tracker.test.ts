import { describe, expect, it, vi } from "vitest";
import { waitForVolumeOperation } from "./volume-operation-tracker";

describe("volume async operation lifecycle (#258)", () => {
  it("polls until the worker actually completes rather than treating HTTP 202 as completed", async () => {
    const fetchOperation = vi.fn()
      .mockResolvedValueOnce({ status: "Pending" })
      .mockResolvedValueOnce({ status: "Running" })
      .mockResolvedValueOnce({ status: "Succeeded" });
    const pause = vi.fn().mockResolvedValue(undefined);
    const state = await waitForVolumeOperation("t1", { id: "op1", status: "Pending" }, fetchOperation, pause);
    expect(state).toMatchObject({ id: "op1", status: "Succeeded" });
    expect(fetchOperation).toHaveBeenCalledTimes(3);
    expect(fetchOperation).toHaveBeenCalledWith("/api/tenants/t1/operations/op1");
    expect(pause).toHaveBeenCalledTimes(2);
  });
  it("surfaces terminal failure including worker message", async () => {
    const state = await waitForVolumeOperation("t1", { id: "op2" },
      vi.fn().mockResolvedValue({ status: "Failed", errorMessage: "StorageQuotaExceeded" }),
      vi.fn().mockResolvedValue(undefined),
    );
    expect(state).toEqual({ id: "op2", status: "Failed", errorMessage: "StorageQuotaExceeded" });
  });
  it("does not claim completion if worker remains pending", async () => {
    const fetchOperation = vi.fn().mockResolvedValue({ status: "Pending" });
    const state = await waitForVolumeOperation("t1", { id: "op3" }, fetchOperation, vi.fn().mockResolvedValue(undefined), 2);
    expect(state.status).toBe("Pending");
    expect(fetchOperation).toHaveBeenCalledTimes(2);
  });
  it("fails closed on malformed acceptance or operation status", async () => {
    await expect(waitForVolumeOperation("t1", {}, vi.fn(), vi.fn())).rejects.toThrow("operation ID");
    await expect(waitForVolumeOperation("t1", { id: "bad" }, vi.fn().mockResolvedValue({}), vi.fn()))
      .rejects.toThrow("verify volume operation state");
  });
});
