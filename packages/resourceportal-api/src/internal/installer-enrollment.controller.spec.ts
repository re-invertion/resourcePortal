import { describe, expect, it, vi } from "vitest";
import { InstallerEnrollmentController } from "./installer-enrollment.controller";

describe("InstallerEnrollmentController", () => {
  it("redeems only the token and role supplied by the join bundle", async () => {
    const service = {
      redeem: vi.fn().mockResolvedValue({ role: "worker", joinToken: "worker-token" }),
    };
    const controller = new InstallerEnrollmentController(service as never);

    await expect(
      controller.redeem({ token: "a".repeat(48), role: "worker" }),
    ).resolves.toEqual({ role: "worker", joinToken: "worker-token" });
    expect(service.redeem).toHaveBeenCalledWith("a".repeat(48), "worker");
  });
});
