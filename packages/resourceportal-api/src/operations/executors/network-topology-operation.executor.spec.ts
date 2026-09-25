/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/unbound-method */
import { describe, expect, it, vi } from "vitest";
import type { NetworkingService } from "../../networking/networking.service";
import type { PrismaService } from "../../prisma/prisma.service";
import type { OperationRecord } from "../operation.types";
import { NetworkTopologyOperationExecutor } from "./network-topology-operation.executor";

function operation(input: unknown): OperationRecord {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    type: "NETWORK_TOPOLOGY_CHANGE",
    tenantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    resourceType: "Network",
    resourceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    status: "Running",
    phase: null,
    createdBy: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    createdByEmail: "admin@example.com",
    createdByDisplayName: "Admin",
    input,
    result: null,
    idempotencyKey: null,
    attempt: 1,
    maxAttempts: 5,
    nextAttemptAt: new Date(),
    leaseOwner: "worker",
    leaseExpiresAt: new Date(),
    heartbeatAt: new Date(),
    errorCode: null,
    errorMessage: null,
    createdAt: new Date(),
    startedAt: new Date(),
    completedAt: null,
  };
}

function fixture() {
  const prisma = {
    networkAttachment: { findFirst: vi.fn() },
    gateNetworkAttachment: { findFirst: vi.fn() },
  } as unknown as PrismaService;
  const networking = {
    attachApplication: vi.fn(),
    detachApplication: vi.fn(),
    attachGateNetwork: vi.fn(),
    detachGateNetwork: vi.fn(),
  } as unknown as NetworkingService;
  return {
    prisma,
    networking,
    executor: new NetworkTopologyOperationExecutor(prisma, networking),
  };
}

describe("NetworkTopologyOperationExecutor", () => {
  it("is replay-safe when an application edge was already created", async () => {
    const { executor, prisma, networking } = fixture();
    (prisma.networkAttachment.findFirst as any).mockResolvedValue({
      id: "edge-1",
      address: "10.240.1.10",
    });

    const result = await executor.execute(
      operation({
        action: "APP_ATTACH",
        networkId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        singleAppId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        expectedRevision: 3,
        snapshot: { networkRevision: 3 },
      }),
    );

    expect(result.result).toMatchObject({
      alreadyApplied: true,
      rollback: "transactional",
      snapshot: { networkRevision: 3 },
    });
    expect(networking.attachApplication).not.toHaveBeenCalled();
  });

  it("executes an application attach with the persisted expected revision", async () => {
    const { executor, prisma, networking } = fixture();
    (prisma.networkAttachment.findFirst as any).mockResolvedValue(null);
    (networking.attachApplication as any).mockResolvedValue({
      id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      address: "10.240.1.10",
      deploymentRequired: true,
    });

    const result = await executor.execute(
      operation({
        action: "APP_ATTACH",
        networkId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        singleAppId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        address: "10.240.1.10",
        expectedRevision: 7,
        snapshot: { networkRevision: 7 },
      }),
    );

    expect(networking.attachApplication).toHaveBeenCalledWith(
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      {
        singleAppId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        address: "10.240.1.10",
        expectedRevision: 7,
      },
      expect.objectContaining({
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        displayName: "Admin",
      }),
    );
    expect(result.result).toMatchObject({
      alreadyApplied: false,
      rollback: "transactional",
    });
  });

  it("is replay-safe after a Gate route edge was removed", async () => {
    const { executor, prisma, networking } = fixture();
    (prisma.gateNetworkAttachment.findFirst as any).mockResolvedValue(null);

    const result = await executor.execute(
      operation({
        action: "GATE_DETACH",
        gateId: "11111111-1111-4111-8111-111111111111",
        networkId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        expectedRevision: 4,
        snapshot: { gateRevision: 4 },
      }),
    );

    expect(result.result).toMatchObject({
      alreadyApplied: true,
      deleted: true,
      reconciliationPending: true,
      rollback: "transactional",
    });
    expect(networking.detachGateNetwork).not.toHaveBeenCalled();
  });
});