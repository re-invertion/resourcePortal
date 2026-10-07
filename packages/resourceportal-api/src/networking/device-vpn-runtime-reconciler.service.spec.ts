/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/unbound-method */
import { ConfigService } from "@nestjs/config";
import { describe, expect, it, vi } from "vitest";
import type { StackRuntimeService } from "../internal/stack-runtime.service";
import type { StackSecretProvisionerService } from "../internal/stack-secret-provisioner.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { EncryptionService } from "../security/encryption.service";
import { DeviceVpnRuntimeReconcilerService } from "./device-vpn-runtime-reconciler.service";

class TestDeviceVpnRuntimeReconcilerService extends DeviceVpnRuntimeReconcilerService {
  readonly dockerCalls: Array<{ args: string[]; stdin?: string }> = [];

  protected override runDocker(args: string[], stdin?: string) {
    this.dockerCalls.push({ args, stdin });
    return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
  }
}

function fixture(devices: any[]) {
  const prisma = {
    deviceVpnGateway: {
      findUnique: vi.fn().mockResolvedValue({
        id: "primary",
        publicKey: "server-public",
        privateKeyCiphertext: "enc-server-private",
        keyVersion: 1,
        runtimeTokenHash: "hash",
        runtimeTokenCiphertext: "enc-runtime-token",
        listenPort: 51820,
        serverTunnelAddress: "100.64.0.1/11",
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    deviceVpnDevice: {
      findMany: vi.fn().mockResolvedValue(devices),
      updateMany: vi.fn().mockResolvedValue({ count: devices.length }),
    },
    $transaction: vi.fn(async (queries: Promise<unknown>[]) =>
      Promise.all(queries),
    ),
  } as unknown as PrismaService;
  const config = {
    get: vi.fn((key: string, fallback?: unknown) => {
      if (key === "RESOURCEPORTAL_RUNTIME_IMAGE") {
        return "ghcr.io/re-invertion/resourceportal-api:test";
      }
      if (key === "PUBLIC_API_URL") {
        return "https://rp.example.test";
      }
      return fallback;
    }),
  } as unknown as ConfigService;
  const encryption = {
    decrypt: vi.fn((value: string) =>
      value === "enc-server-private" ? "server-private" : "runtime-token",
    ),
  } as unknown as EncryptionService;
  const runtime = {
    reconcileTenantNetwork: vi.fn().mockResolvedValue({
      success: true,
      changed: false,
    }),
  } as unknown as StackRuntimeService;
  const secrets = {
    provisionSecrets: vi.fn().mockResolvedValue({
      success: true,
      message: "ok",
      details: "",
    }),
  } as unknown as StackSecretProvisionerService;

  return {
    prisma,
    runtime,
    secrets,
    service: new TestDeviceVpnRuntimeReconcilerService(
      prisma,
      config,
      encryption,
      runtime,
      secrets,
    ),
  };
}

const tenantId = "11111111-1111-4111-8111-111111111111";

function device(overrides: Record<string, unknown> = {}) {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    tenantId,
    userId: "44444444-4444-4444-8444-444444444444",
    publicKey: "peer-public",
    assignedAddress: "100.64.0.2",
    revokedAt: null,
    user: {
      status: "Active",
      memberships: [{ tenantId }],
    },
    networks: [],
    ...overrides,
  };
}

describe("DeviceVpnRuntimeReconcilerService", () => {
  it("fails closed and removes a peer when the user no longer has an active tenant membership", async () => {
    const { service, prisma, runtime, secrets } = fixture([
      device({
        user: {
          status: "Active",
          memberships: [],
        },
      }),
    ]);

    await expect(service.reconcile()).resolves.toEqual({
      configured: true,
      devices: 0,
      networks: 0,
      deployed: false,
    });

    expect(prisma.deviceVpnDevice.updateMany).toHaveBeenCalledWith({
      where: {
        id: {
          in: ["33333333-3333-4333-8333-333333333333"],
        },
        revokedAt: null,
      },
      data: {
        status: "Suspended",
        lastError: "Tenant membership or user account is not active",
      },
    });
    expect(runtime.reconcileTenantNetwork).not.toHaveBeenCalled();
    expect(secrets.provisionSecrets).not.toHaveBeenCalled();
    expect(service.dockerCalls).toContainEqual({
      args: ["stack", "rm", "rp_device_vpn"],
      stdin: undefined,
    });
  });

  it("fails closed and removes a peer when the user account is suspended", async () => {
    const { service, prisma } = fixture([
      device({
        user: {
          status: "Suspended",
          memberships: [{ tenantId }],
        },
      }),
    ]);

    await service.reconcile();

    expect(prisma.deviceVpnDevice.updateMany).toHaveBeenCalledWith({
      where: {
        id: {
          in: ["33333333-3333-4333-8333-333333333333"],
        },
        revokedAt: null,
      },
      data: {
        status: "Suspended",
        lastError: "Tenant membership or user account is not active",
      },
    });
  });
});
