import { ConflictException, type INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma, RuntimeState } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { CapacityPreflightService } from "../capacity/capacity-preflight.service";
import { StackRuntimeService } from "../internal/stack-runtime.service";
import { PrismaService } from "../prisma/prisma.service";
import { RegistriesService } from "../registries/registries.service";
import { EncryptionService } from "../security/encryption.service";
import { SecretStorageService } from "../security/secret-storage.service";
import { VolumesService } from "../volumes/volumes.service";
import { Stage15AppGroupsService } from "./stage15-app-groups.service";

void (null as unknown as INestApplication);

describe("Stage 15 runtime capacity boundary", () => {
  it("does not persist Running or scale Swarm when capacity rejects AppGroup start", async () => {
    const appGroupId = "00000000-0000-0000-0000-000000000101";
    const tenantId = "00000000-0000-0000-0000-000000000201";
    const singleAppId = "00000000-0000-0000-0000-000000000301";
    const actor = { id: "user-1", displayName: "User One" } as never;

    const persistedUpdate = vi.fn();
    const tx = {
      appGroup: {
        findFirst: vi.fn().mockResolvedValue({
          id: appGroupId,
          tenantId,
          name: "api",
          status: "Ready",
          runtimeState: RuntimeState.Stopped,
          currentDeploymentVersion: 1,
          singleApps: [
            {
              id: singleAppId,
              name: "web",
              runtimeState: RuntimeState.Running,
              desiredReplicas: 1,
              actualReplicas: 0,
              pendingDeletion: false,
            },
          ],
        }),
        update: persistedUpdate,
      },
      appGroupDeployment: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      tenant: { findUniqueOrThrow: vi.fn() },
      auditLogEntry: { create: vi.fn() },
    } as unknown as Prisma.TransactionClient;

    const prisma = {
      appGroup: {
        findFirst: vi.fn().mockResolvedValue({
          id: appGroupId,
          status: "Ready",
          runtimeState: RuntimeState.Stopped,
          currentDeploymentVersion: 1,
          tenant: {
            status: "Active",
            billing: { balance: new Prisma.Decimal(10) },
          },
          singleApps: [],
        }),
      },
      $transaction: vi.fn(
        (callback: (client: Prisma.TransactionClient) => Promise<unknown>) =>
          callback(tx),
      ),
    } as unknown as PrismaService;
    const stackRuntime = {
      scaleServices: vi.fn(),
    } as unknown as StackRuntimeService;
    const capacity = {
      admitRuntimeStart: vi.fn().mockResolvedValue({
        success: false,
        errorCode: "InsufficientCapacity",
        message: "Insufficient platform cpu capacity",
      }),
    } as unknown as CapacityPreflightService;
    const config = {
      get: vi.fn().mockReturnValue(undefined),
    } as unknown as ConfigService;

    const service = new Stage15AppGroupsService(
      prisma,
      {} as RegistriesService,
      {} as EncryptionService,
      {} as SecretStorageService,
      stackRuntime,
      {} as VolumesService,
      config,
      capacity,
    );

    await expect(
      service.startAppGroup(tenantId, appGroupId, actor),
    ).rejects.toMatchObject({
      response: {
        code: "InsufficientCapacity",
      },
    } satisfies Partial<ConflictException>);

    expect(capacity.admitRuntimeStart).toHaveBeenCalledWith(tx, { appGroupId });
    expect(persistedUpdate).not.toHaveBeenCalled();
    expect(stackRuntime.scaleServices).not.toHaveBeenCalled();
  });
});