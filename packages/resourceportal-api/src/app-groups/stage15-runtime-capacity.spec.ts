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
    const scaleServices = vi.fn();
    const stackRuntime = { scaleServices } as unknown as StackRuntimeService;
    const lockRuntimeMutation = vi.fn().mockResolvedValue(undefined);
    const admitRuntimeStart = vi.fn().mockResolvedValue({
      success: false,
      errorCode: "InsufficientCapacity",
      message: "Insufficient platform cpu capacity",
    });
    const capacity = {
      lockRuntimeMutation,
      admitRuntimeStart,
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
    });

    expect(lockRuntimeMutation).toHaveBeenCalledWith(tx);
    expect(admitRuntimeStart).toHaveBeenCalledWith(tx, { appGroupId });
    expect(persistedUpdate).not.toHaveBeenCalled();
    expect(scaleServices).not.toHaveBeenCalled();
  });

  it("acquires the runtime capacity lock before reading AppGroup state for start", async () => {
    const appGroupId = "00000000-0000-0000-0000-000000000102";
    const tenantId = "00000000-0000-0000-0000-000000000202";
    const actor = { id: "user-2", displayName: "User Two" } as never;
    const order: string[] = [];

    const tx = {
      appGroup: {
        findFirst: vi.fn().mockImplementation(async () => {
          order.push("read");
          return {
            id: appGroupId,
            tenantId,
            name: "api",
            status: "Ready",
            runtimeState: RuntimeState.Stopped,
            currentDeploymentVersion: null,
            singleApps: [],
          };
        }),
        update: vi.fn().mockResolvedValue({
          id: appGroupId,
          tenantId,
          name: "api",
          runtimeState: RuntimeState.Running,
          currentDeploymentVersion: null,
          singleApps: [],
        }),
      },
      appGroupDeployment: { findFirst: vi.fn().mockResolvedValue(null) },
      tenant: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({ name: "Tenant" }),
      },
      auditLogEntry: { create: vi.fn().mockResolvedValue({}) },
    } as unknown as Prisma.TransactionClient;
    const prisma = {
      appGroup: {
        findFirst: vi.fn().mockResolvedValue({
          id: appGroupId,
          status: "Ready",
          runtimeState: RuntimeState.Stopped,
          currentDeploymentVersion: null,
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
    const capacity = {
      lockRuntimeMutation: vi.fn().mockImplementation(async () => {
        order.push("lock");
      }),
      admitRuntimeStart: vi.fn().mockImplementation(async () => {
        order.push("admit");
        return {
          success: true,
          demand: { cpuNano: 0n, memoryBytes: 0n },
          occupied: { cpuNano: 0n, memoryBytes: 0n },
          supply: { cpuNano: 0n, memoryBytes: 0n },
        };
      }),
    } as unknown as CapacityPreflightService;
    const service = new Stage15AppGroupsService(
      prisma,
      {} as RegistriesService,
      {} as EncryptionService,
      {} as SecretStorageService,
      { scaleServices: vi.fn() } as unknown as StackRuntimeService,
      {} as VolumesService,
      { get: vi.fn() } as unknown as ConfigService,
      capacity,
    );

    await service.startAppGroup(tenantId, appGroupId, actor);

    expect(order).toEqual(["lock", "read", "admit"]);
  });

  it("serializes AppGroup stop with the Stage 15 runtime capacity lock", async () => {
    const appGroupId = "00000000-0000-0000-0000-000000000103";
    const tenantId = "00000000-0000-0000-0000-000000000203";
    const actor = { id: "user-3", displayName: "User Three" } as never;
    const order: string[] = [];

    const tx = {
      appGroup: {
        findFirst: vi.fn().mockImplementation(async () => {
          order.push("read");
          return {
            id: appGroupId,
            tenantId,
            name: "api",
            status: "Ready",
            runtimeState: RuntimeState.Running,
            currentDeploymentVersion: null,
            singleApps: [],
          };
        }),
        update: vi.fn().mockResolvedValue({
          id: appGroupId,
          tenantId,
          name: "api",
          runtimeState: RuntimeState.Stopped,
          currentDeploymentVersion: null,
          singleApps: [],
        }),
      },
      appGroupDeployment: { findFirst: vi.fn().mockResolvedValue(null) },
      tenant: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({ name: "Tenant" }),
      },
      auditLogEntry: { create: vi.fn().mockResolvedValue({}) },
    } as unknown as Prisma.TransactionClient;
    const prisma = {
      $transaction: vi.fn(
        (callback: (client: Prisma.TransactionClient) => Promise<unknown>) =>
          callback(tx),
      ),
    } as unknown as PrismaService;
    const capacity = {
      lockRuntimeMutation: vi.fn().mockImplementation(async () => {
        order.push("lock");
      }),
      admitRuntimeStart: vi.fn(),
    } as unknown as CapacityPreflightService;
    const service = new Stage15AppGroupsService(
      prisma,
      {} as RegistriesService,
      {} as EncryptionService,
      {} as SecretStorageService,
      { scaleServices: vi.fn() } as unknown as StackRuntimeService,
      {} as VolumesService,
      { get: vi.fn() } as unknown as ConfigService,
      capacity,
    );

    await service.stopAppGroup(tenantId, appGroupId, actor);

    expect(order).toEqual(["lock", "read"]);
  });
});