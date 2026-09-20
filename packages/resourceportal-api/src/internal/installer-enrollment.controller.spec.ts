import { describe, expect, it, vi } from "vitest";
import { InstallerEnrollmentController } from "./installer-enrollment.controller";

describe("InstallerEnrollmentController v0.2", () => {
  it("queues redemption with the client public key", async () => {
    const service = {
      beginRedemption: vi.fn().mockResolvedValue({
        status: "pending",
        role: "worker",
        operationId: "10000000-0000-0000-0000-000000000001",
      }),
    };
    const controller = new InstallerEnrollmentController(service as never);
    const dto = {
      token: "a".repeat(48),
      role: "worker" as const,
      publicKey: "-----BEGIN PUBLIC KEY-----\nkey\n-----END PUBLIC KEY-----",
    };

    await controller.redeem(dto);
    expect(service.beginRedemption).toHaveBeenCalledWith(
      dto.token,
      dto.role,
      dto.publicKey,
    );
  });

  it("delegates redemption status without any Docker dependency", async () => {
    const service = {
      redemptionStatus: vi.fn().mockResolvedValue({ status: "pending" }),
    };
    const controller = new InstallerEnrollmentController(service as never);
    const dto = {
      token: "a".repeat(48),
      role: "manager" as const,
      operationId: "10000000-0000-0000-0000-000000000001",
    };

    await controller.redemptionStatus(dto);
    expect(service.redemptionStatus).toHaveBeenCalledWith(
      dto.token,
      dto.role,
      dto.operationId,
    );
  });

  it("queues completion instead of labeling the node in the listener", async () => {
    const service = {
      beginCompletion: vi.fn().mockResolvedValue({
        status: "pending",
        operationId: "10000000-0000-0000-0000-000000000002",
      }),
    };
    const controller = new InstallerEnrollmentController(service as never);
    const dto = {
      token: "a".repeat(48),
      role: "manager" as const,
      nodeId: "abcdefghijklmnopqrstuvwxy",
      controlPlane: true,
      ingress: false,
    };

    await controller.complete(dto);
    expect(service.beginCompletion).toHaveBeenCalledWith(
      dto.token,
      dto.role,
      dto.nodeId,
      true,
      false,
    );
  });
});
