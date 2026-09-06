import { describe, expect, it, vi } from "vitest";
import { InstallerEnrollmentController } from "./installer-enrollment.controller";

describe("InstallerEnrollmentController", () => {
  it("redeems only the token and role supplied by the join bundle", async () => {
    const service = {
      redeem: vi.fn().mockResolvedValue({ role: "worker", joinToken: "worker-token" }),
    };
    const controller = new InstallerEnrollmentController(service as never, { apply: vi.fn() } as never);

    await expect(
      controller.redeem({ token: "a".repeat(48), role: "worker" }),
    ).resolves.toEqual({ role: "worker", joinToken: "worker-token" });
    expect(service.redeem).toHaveBeenCalledWith("a".repeat(48), "worker");
  });
  it("claims a joined node before applying role-appropriate labels", async () => {
    const completedAt = new Date("2026-09-05T12:06:00.000Z");
    const service = {
      claimCompletion: vi.fn().mockResolvedValue({ role: "manager", completedAt }),
      releaseCompletionClaim: vi.fn(),
    };
    const labels = { apply: vi.fn().mockResolvedValue(undefined) };
    const controller = new InstallerEnrollmentController(service as never, labels as never);

    await expect(
      controller.complete({
        token: "a".repeat(48),
        role: "manager",
        nodeId: "abcdefghijklmnopqrstuvwxy",
        controlPlane: true,
        ingress: false,
      }),
    ).resolves.toEqual({ status: "completed", role: "manager" });
    expect(service.claimCompletion).toHaveBeenCalled();
    expect(labels.apply).toHaveBeenCalledWith(
      "abcdefghijklmnopqrstuvwxy",
      "manager",
      true,
      false,
    );
    expect(service.releaseCompletionClaim).not.toHaveBeenCalled();
  });

  it("releases the completion claim when Docker label application fails", async () => {
    const completedAt = new Date("2026-09-05T12:06:00.000Z");
    const service = {
      claimCompletion: vi.fn().mockResolvedValue({ role: "worker", completedAt }),
      releaseCompletionClaim: vi.fn().mockResolvedValue(undefined),
    };
    const labels = { apply: vi.fn().mockRejectedValue(new Error("docker failed")) };
    const controller = new InstallerEnrollmentController(service as never, labels as never);
    const dto = { token: "a".repeat(48), role: "worker" as const, nodeId: "abcdefghijklmnopqrstuvwxy", controlPlane: false, ingress: false };

    await expect(controller.complete(dto)).rejects.toThrow("docker failed");
    expect(service.releaseCompletionClaim).toHaveBeenCalledWith(
      dto.token, dto.role, dto.nodeId, completedAt,
    );
  });

});
