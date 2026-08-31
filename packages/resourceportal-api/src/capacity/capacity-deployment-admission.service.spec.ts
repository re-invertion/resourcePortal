import { DeploymentPhase, DeploymentStatus, Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import { CapacityDeploymentAdmissionService } from "./capacity-deployment-admission.service";
import { CapacityPreflightService } from "./capacity-preflight.service";

const snapshot = {
  appGroup: {
    id: "00000000-0000-0000-0000-000000000101",
    tenantId: "00000000-0000-0000-0000-000000000201",
    runtimeState: "Running",
  },
  singleApps: [
    {
      runtimeState: "Running",
      desiredReplicas: 1,
      resources: { cpu: "1", memoryBytes: "1024", gpu: 0 },
      volumes: [],
    },
  ],
};

const deployment = {
  id: "00000000-0000-0000-0000-000000000501",
  leaseOwner: "worker-1",
  leaseExpiresAt: new Date("2026-08-31T10:00:00Z"),
};

describe("Stage 15 deployment admission boundary", () => {
  it("checks capacity and advances to PreparingArtifacts in the same transaction", async () => {
    const update = vi.fn().mockResolvedValue({
      ...deployment,
      phase: DeploymentPhase.PreparingArtifacts,
      status: DeploymentStatus.Deploying,
    });
    const createEvent = vi.fn().mockResolvedValue({ id: "event-1" });
    const tx = {
      appGroupDeployment: { update },
      deploymentEvent: { create: createEvent },
    } as unknown as Prisma.TransactionClient;
    const transaction = vi.fn(async (callback: (client: Prisma.TransactionClient) => unknown) =>
      callback(tx),
    );
    const prisma = { $transaction: transaction } as unknown as PrismaService;
    const admitDeployment = vi.fn().mockResolvedValue({
      success: true,
      demand: { cpuNano: 1_000_000_000n, memoryBytes: 1024n },
      occupied: { cpuNano: 0n, memoryBytes: 0n },
      supply: { cpuNano: 4_000_000_000n, memoryBytes: 8192n },
    });
    const preflight = { admitDeployment } as unknown as CapacityPreflightService;
    const service = new CapacityDeploymentAdmissionService(prisma, preflight);

    const result = await service.admitAndAdvance(deployment, snapshot, "capacity admitted");

    expect(result).toMatchObject({ success: true });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(admitDeployment).toHaveBeenCalledWith(tx, snapshot);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: deployment.id },
        data: expect.objectContaining({
          phase: DeploymentPhase.PreparingArtifacts,
          status: DeploymentStatus.Deploying,
        }),
      }),
    );
    expect(createEvent).toHaveBeenCalledTimes(1);
  });

  it("does not reserve the phase when capacity admission fails", async () => {
    const update = vi.fn();
    const tx = {
      appGroupDeployment: { update },
      deploymentEvent: { create: vi.fn() },
    } as unknown as Prisma.TransactionClient;
    const prisma = {
      $transaction: vi.fn(async (callback: (client: Prisma.TransactionClient) => unknown) =>
        callback(tx),
      ),
    } as unknown as PrismaService;
    const preflight = {
      admitDeployment: vi.fn().mockResolvedValue({
        success: false,
        errorCode: "InsufficientCapacity",
        message: "Insufficient platform cpu capacity",
      }),
    } as unknown as CapacityPreflightService;
    const service = new CapacityDeploymentAdmissionService(prisma, preflight);

    await expect(
      service.admitAndAdvance(deployment, snapshot),
    ).resolves.toEqual({
      success: false,
      errorCode: "InsufficientCapacity",
      message: "Insufficient platform cpu capacity",
    });
    expect(update).not.toHaveBeenCalled();
  });
});
