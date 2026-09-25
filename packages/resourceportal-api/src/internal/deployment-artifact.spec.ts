import { ConflictException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../prisma/prisma.service";
import type { EncryptionService } from "../security/encryption.service";
import {
  deploymentArtifactMatches,
  deploymentArtifactSha256,
} from "./deployment-artifact";
import { DeploymentExecutionService } from "./deployment-execution.service";

type ArtifactState = {
  id: string;
  stackConfig: string | null;
  renderedStack: string | null;
  renderedStackSha256: string | null;
  renderedAt: Date | null;
};

type UpdateManyArgs = {
  where: Record<string, unknown>;
  data: Record<string, unknown>;
};

function serviceWithPrisma(
  prisma: PrismaService,
  encryption: EncryptionService = undefined as never,
) {
  return new DeploymentExecutionService(
    prisma,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    encryption,
    undefined as never,
  );
}

function fakePrismaFor(state: ArtifactState) {
  const updateMany = vi.fn((args: UpdateManyArgs) => {
    if (typeof args.data.renderedStack === "string") {
      state.renderedStack = args.data.renderedStack;
    }
    if (typeof args.data.renderedStackSha256 === "string") {
      state.renderedStackSha256 = args.data.renderedStackSha256;
    }
    if (args.data.renderedAt instanceof Date) {
      state.renderedAt = args.data.renderedAt;
    }
    return Promise.resolve({ count: 1 });
  });
  const prisma = {
    appGroupDeployment: {
      findUnique: vi.fn(() => Promise.resolve({ ...state })),
      updateMany,
      findUniqueOrThrow: vi.fn(() =>
        Promise.resolve({
          renderedStack: state.renderedStack,
          renderedStackSha256: state.renderedStackSha256,
        }),
      ),
    },
  } as unknown as PrismaService;
  return { prisma, updateMany };
}

function legacyStackConfig(appGroupId: string) {
  return JSON.stringify({
    appGroup: {
      id: appGroupId,
      tenantId: "99999999-9999-4999-8999-999999999999",
      name: "legacy-group",
      runtimeState: "Running",
      runtimeDraftRevision: 1,
    },
    singleApps: [],
  });
}

describe("deployment artifact integrity", () => {
  it("hashes the exact UTF-8 bytes without YAML normalization", () => {
    const first = "services:\n  web:\n    image: nginx\n";
    const second = "services:\r\n  web:\r\n    image: nginx\r\n";
    expect(deploymentArtifactSha256(first)).not.toBe(
      deploymentArtifactSha256(second),
    );
    expect(
      deploymentArtifactMatches(first, deploymentArtifactSha256(first)),
    ).toBe(true);
  });

  it("backfills a digest for a v0.1.x renderedStack without changing its bytes", async () => {
    const renderedStack = "services:\n  api:\n    image: legacy:v1\n";
    const digest = deploymentArtifactSha256(renderedStack);
    const state: ArtifactState = {
      id: "deployment-1",
      stackConfig: "{}",
      renderedStack,
      renderedStackSha256: null,
      renderedAt: new Date("2026-01-01T00:00:00Z"),
    };
    const { prisma, updateMany } = fakePrismaFor(state);
    const service = serviceWithPrisma(prisma);

    await expect(service.ensureDeploymentArtifact("deployment-1")).resolves.toEqual({
      renderedStack,
      sha256: digest,
    });

    const update = updateMany.mock.calls[0]?.[0];
    expect(update?.data.renderedStackSha256).toBe(digest);
    expect(Object.hasOwn(update?.data ?? {}, "renderedStack")).toBe(false);
    expect(state.renderedStack).toBe(renderedStack);
  });

  it("materializes a missing legacy renderedStack exactly once and persists bytes plus digest", async () => {
    const appGroupId = "22222222-2222-4222-8222-222222222222";
    const state: ArtifactState = {
      id: "deployment-2",
      stackConfig: legacyStackConfig(appGroupId),
      renderedStack: null,
      renderedStackSha256: null,
      renderedAt: null,
    };
    const { prisma, updateMany } = fakePrismaFor(state);
    const service = serviceWithPrisma(prisma);

    const first = await service.ensureDeploymentArtifact("deployment-2");
    const second = await service.ensureDeploymentArtifact("deployment-2");

    expect(first).toEqual(second);
    expect(first.renderedStack).toContain(`rp-appgroup-${appGroupId}`);
    expect(first.sha256).toBe(deploymentArtifactSha256(first.renderedStack));
    expect(updateMany).toHaveBeenCalledTimes(1);
    const update = updateMany.mock.calls[0]?.[0];
    expect(update?.where).toEqual({ id: "deployment-2", renderedStack: null });
    expect(update?.data.renderedStack).toBe(first.renderedStack);
    expect(update?.data.renderedStackSha256).toBe(first.sha256);
    expect(update?.data.renderedAt).toBeInstanceOf(Date);
  });


  it("renders protected sensitive environment only in memory without persisting plaintext", async () => {
    const protectedValue = "enc:v1:iv:tag:ciphertext";
    const appGroupId = "22222222-2222-4222-8222-222222222222";
    const stackConfig = JSON.stringify({
      appGroup: {
        id: appGroupId,
        tenantId: "99999999-9999-4999-8999-999999999999",
        name: "protected-group",
        runtimeState: "Running",
        runtimeDraftRevision: 1,
      },
      singleApps: [
        {
          id: "app-1",
          name: "db",
          image: "postgres:15",
          registryId: null,
          desiredReplicas: 1,
          runtimeState: "Running",
          resources: { cpu: "0.5", memoryBytes: "536870912", gpu: 0 },
          environment: { POSTGRES_PASSWORD: protectedValue },
          variables: [],
          secrets: [],
          configs: [],
          healthCheck: null,
          entrypoint: null,
          command: [],
          workingDir: null,
          user: null,
          readOnlyRootFilesystem: false,
          stopGracePeriodSeconds: 30,
          restartPolicy: {},
          updatePolicy: {},
          httpEndpoints: [],
          volumes: [],
        },
      ],
    });
    const state: ArtifactState = {
      id: "deployment-protected",
      stackConfig,
      renderedStack: null,
      renderedStackSha256: null,
      renderedAt: null,
    };
    const { prisma, updateMany } = fakePrismaFor(state);
    const encryption = {
      decrypt: vi.fn((value: string) =>
        value === protectedValue ? "runtime-only-password" : value,
      ),
    } as unknown as EncryptionService;
    const service = serviceWithPrisma(prisma, encryption);

    const artifact = await service.ensureDeploymentArtifact("deployment-protected");

    expect(artifact.renderedStack).toContain("runtime-only-password");
    expect(artifact.renderedStack).not.toContain(protectedValue);
    expect(artifact.sha256).toBe(
      deploymentArtifactSha256(artifact.renderedStack),
    );
    expect(updateMany).not.toHaveBeenCalled();
    expect(state.renderedStack).toBeNull();
    expect(state.renderedStackSha256).toBeNull();
  });

  it("rejects a persisted artifact whose bytes no longer match its digest", async () => {
    const state: ArtifactState = {
      id: "deployment-3",
      stackConfig: "{}",
      renderedStack: "services: {}\n# modified\n",
      renderedStackSha256: deploymentArtifactSha256("services: {}\n"),
      renderedAt: new Date(),
    };
    const { prisma, updateMany } = fakePrismaFor(state);
    const service = serviceWithPrisma(prisma);

    await expect(service.ensureDeploymentArtifact("deployment-3")).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(updateMany).not.toHaveBeenCalled();
  });
});
