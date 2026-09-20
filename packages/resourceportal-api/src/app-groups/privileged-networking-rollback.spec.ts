import { ConflictException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../prisma/prisma.service";
import { AppGroupsService } from "./app-groups.service";
import {
  internalPortExposureCountFromStackConfig,
  stackConfigHasInternalPortExposures,
} from "./internal-port-exposure-snapshot";

const tenantId = "11111111-1111-4111-8111-111111111111";
const appGroupId = "22222222-2222-4222-8222-222222222222";
const deploymentId = "33333333-3333-4333-8333-333333333333";
const actor = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  email: "admin@example.com",
  displayName: "Admin",
  status: "Active",
} as never;

const privilegedSnapshot = JSON.stringify({
  appGroup: { id: appGroupId },
  singleApps: [
    {
      id: "44444444-4444-4444-8444-444444444444",
      internalPortExposures: [
        {
          id: "55555555-5555-4555-8555-555555555555",
          name: "dns-udp",
          containerPort: 53,
          publishedPort: 53,
          protocol: "udp",
        },
      ],
    },
  ],
});

describe("privileged networking rollback safety", () => {
  it("parses Internal Port Exposures from immutable deployment snapshots", () => {
    expect(internalPortExposureCountFromStackConfig(privilegedSnapshot)).toBe(1);
    expect(stackConfigHasInternalPortExposures(privilegedSnapshot)).toBe(true);
    expect(internalPortExposureCountFromStackConfig("not-json")).toBe(0);
  });

  it("blocks rollback to a privileged-port deployment after privilege was revoked", async () => {
    const deploymentCreate = vi.fn();
    const tx = {
      appGroupDeployment: {
        findFirst: vi.fn((args: { where?: Record<string, unknown> }) => {
          if (args.where?.id === deploymentId) {
            return Promise.resolve({
              id: deploymentId,
              appGroupId,
              version: 2,
              status: "Succeeded",
              stackConfig: privilegedSnapshot,
            });
          }
          if (args.where?.status) return Promise.resolve(null);
          return Promise.resolve(null);
        }),
        create: deploymentCreate,
      },
      appGroup: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          name: "dns",
          runtimeDraftRevision: 4,
          networkPrivileged: false,
        }),
      },
    };
    const prisma = {
      appGroup: {
        findFirst: vi.fn().mockResolvedValue({ id: appGroupId }),
      },
      $transaction: vi.fn(
        (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
      ),
    };
    const service = new AppGroupsService(
      prisma as unknown as PrismaService,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );

    await expect(
      service.rollbackDeployment(
        tenantId,
        appGroupId,
        deploymentId,
        {},
        undefined,
        actor,
      ),
    ).rejects.toThrow(
      "Rollback target contains Internal Port Exposures and requires Platform Admin privileged networking",
    );
    await expect(
      service.rollbackDeployment(
        tenantId,
        appGroupId,
        deploymentId,
        {},
        undefined,
        actor,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(deploymentCreate).not.toHaveBeenCalled();
  });
});
