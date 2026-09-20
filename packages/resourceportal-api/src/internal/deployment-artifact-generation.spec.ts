import { DeploymentPhase, DeploymentStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../prisma/prisma.service";
import { deploymentArtifactSha256 } from "./deployment-artifact";
import { DeploymentExecutionService } from "./deployment-execution.service";

type DeploymentUpdateArgs = {
  where: { id: string };
  data: Record<string, unknown>;
};

type FakeTransaction = {
  appGroupDeployment: {
    update: (args: DeploymentUpdateArgs) => Promise<Record<string, unknown>>;
  };
  deploymentEvent: {
    create: (args: unknown) => Promise<Record<string, never>>;
  };
};

function serviceWithPrisma(prisma: PrismaService) {
  return new DeploymentExecutionService(
    prisma,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
  );
}

describe("new deployment artifact generation", () => {
  it("persists rendered bytes and their SHA-256 atomically in GeneratingStack", async () => {
    const deployment = {
      id: "11111111-1111-4111-8111-111111111111",
      appGroupId: "22222222-2222-4222-8222-222222222222",
      version: 2,
      status: DeploymentStatus.Deploying,
      phase: DeploymentPhase.PreparingArtifacts,
      stackConfig: JSON.stringify({
        appGroup: {
          id: "22222222-2222-4222-8222-222222222222",
          tenantId: "55555555-5555-4555-8555-555555555555",
          name: "group",
          runtimeState: "Running",
          runtimeDraftRevision: 2,
        },
        singleApps: [],
      }),
      renderedStack: null,
      renderedStackSha256: null,
      renderedAt: null,
      sourceDraftRevision: 2,
      rollbackTargetVersion: null,
      leaseOwner: "worker-a",
      leaseExpiresAt: new Date(Date.now() + 60_000),
      heartbeatAt: new Date(),
      correlationId: "33333333-3333-4333-8333-333333333333",
      idempotencyKey: null,
      errorCode: null,
      errorMessage: null,
      createdBy: "44444444-4444-4444-8444-444444444444",
      createdAt: new Date(),
      startedAt: new Date(),
      completedAt: null,
    };

    const update = vi.fn((args: DeploymentUpdateArgs) =>
      Promise.resolve({ ...deployment, ...args.data }),
    );
    const tx: FakeTransaction = {
      appGroupDeployment: { update },
      deploymentEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const fakePrisma = {
      appGroupDeployment: {
        findUnique: vi.fn().mockResolvedValue(deployment),
      },
      $transaction: vi.fn(
        (callback: (client: FakeTransaction) => Promise<unknown>) => callback(tx),
      ),
    } as unknown as PrismaService;
    const service = serviceWithPrisma(fakePrisma);

    await service.advanceDeployment(deployment.id, {
      workerId: "worker-a",
      phase: DeploymentPhase.GeneratingStack,
    });

    const updateArgs = update.mock.calls[0]?.[0];
    expect(updateArgs).toBeDefined();
    const renderedStack = updateArgs?.data.renderedStack;
    expect(renderedStack).toEqual(expect.any(String));
    if (typeof renderedStack !== "string") throw new Error("Expected rendered stack");

    expect(updateArgs?.data).toMatchObject({
      phase: DeploymentPhase.GeneratingStack,
      renderedStack,
      renderedStackSha256: deploymentArtifactSha256(renderedStack),
    });
    expect(updateArgs?.data.renderedAt).toBeInstanceOf(Date);
  });
});
