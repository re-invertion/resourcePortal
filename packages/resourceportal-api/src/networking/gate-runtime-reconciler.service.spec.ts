/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/unbound-method */
import { ConfigService } from "@nestjs/config";
import { describe, expect, it, vi } from "vitest";
import type { StackRuntimeService } from "../internal/stack-runtime.service";
import type { StackSecretProvisionerService } from "../internal/stack-secret-provisioner.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { EncryptionService } from "../security/encryption.service";
import { GateRuntimeReconcilerService } from "./gate-runtime-reconciler.service";

class TestGateRuntimeReconcilerService extends GateRuntimeReconcilerService {
  readonly dockerCalls: Array<{ args: string[]; stdin?: string }> = [];
  readonly dockerResults: Array<{ exitCode: number; stdout: string; stderr: string }> = [];

  protected override runDocker(args: string[], stdin?: string) {
    this.dockerCalls.push({ args, stdin });
    return Promise.resolve(
      this.dockerResults.shift() ?? { exitCode: 0, stdout: "", stderr: "" },
    );
  }
}

function fixture(gates: any[], deletingNetworks: any[] = []) {
  const prisma = {
    resourcePortalGate: {
      findMany: vi.fn().mockResolvedValue(gates),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    gateNetworkAttachment: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    network: {
      findMany: vi.fn().mockResolvedValue(deletingNetworks),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    $transaction: vi.fn(async (queries: Promise<unknown>[]) =>
      Promise.all(queries),
    ),
  } as unknown as PrismaService;
  const config = {
    get: vi.fn((key: string, fallback?: unknown) =>
      key === "RESOURCEPORTAL_RUNTIME_IMAGE"
        ? "ghcr.io/re-invertion/resourceportal-api:test"
        : fallback,
    ),
  } as unknown as ConfigService;
  const encryption = {
    decrypt: vi.fn().mockReturnValue("server-private-key"),
  } as unknown as EncryptionService;
  const runtime = {
    reconcileTenantNetwork: vi
      .fn()
      .mockResolvedValue({ success: true, changed: false }),
    removeTenantNetwork: vi
      .fn()
      .mockResolvedValue({ success: true, changed: true }),
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
    encryption,
    runtime,
    secrets,
    service: new TestGateRuntimeReconcilerService(
      prisma,
      config,
      encryption,
      runtime,
      secrets,
    ),
  };
}

const readyGate = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  tenantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  status: "Ready",
  publicKey: "client-public-key",
  serverPrivateKeyCiphertext: "enc:v1:cipher",
  serverKeyVersion: 2,
  serverListenPort: 52001,
  serverTunnelAddress: "10.253.0.1/30",
  clientTunnelAddress: "10.253.0.2/30",
  revokedAt: null,
  lanCidrs: ["192.168.50.0/24"],
  networks: [
    {
      enabled: true,
      network: {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        swarmNetworkName:
          "rp-network-cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        overlayCidr: "10.200.5.0/24",
        attachments: [
          {
            id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            address: "10.240.5.10",
          },
        ],
      },
    },
  ],
};

describe("GateRuntimeReconcilerService", () => {
  it("prepares networks, provisions the versioned key and deploys one Gate stack", async () => {
    const { service, runtime, secrets, encryption } = fixture([readyGate]);

    await expect(service.reconcile()).resolves.toEqual({
      gates: 1,
      ready: 1,
      pending: 0,
      removed: 0,
      failed: 0,
      networksDeleting: 0,
      networksDeleted: 0,
      networkDeleteFailures: 0,
    });

    expect(runtime.reconcileTenantNetwork).toHaveBeenCalledWith({
      networkName: "rp-network-cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      subnet: "10.200.5.0/24",
      networkId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      tenantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    expect(encryption.decrypt).toHaveBeenCalledWith("enc:v1:cipher");
    expect(secrets.provisionSecrets).toHaveBeenCalledWith([
      {
        dockerSecretName:
          "rp-gate-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-private-key-v2",
        value: "server-private-key",
      },
    ]);
    const deploy = service.dockerCalls.find(
      (call) => call.args[0] === "stack" && call.args[1] === "deploy",
    );
    expect(deploy?.args.at(-1)).toBe(
      "rp_gate_aaaaaaaa_aaaa_4aaa_8aaa_aaaaaaaaaaaa",
    );
    expect(deploy?.stdin).toContain("published: 52001");
    const encoded = deploy?.stdin?.match(/RP_GATE_CONFIG_B64:\s+(\S+)/)?.[1];
    expect(encoded).toBeTruthy();
    const runtimeConfig = JSON.parse(
      Buffer.from(encoded ?? "", "base64").toString("utf8"),
    );
    expect(runtimeConfig.mappings).toEqual([
      {
        stableAddress: "10.240.5.10",
        overlayCidr: "10.200.5.0/24",
        attachmentAlias: "rp-att-dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      },
    ]);
  });

  it("permanently deletes a Gate only after its runtime and private key are removed", async () => {
    const { service, prisma } = fixture([
      {
        ...readyGate,
        status: "Deleting",
        revokedAt: new Date(),
        networks: [],
      },
    ]);

    await expect(service.reconcile()).resolves.toMatchObject({
      removed: 1,
      failed: 0,
    });
    expect(service.dockerCalls.map((call) => call.args)).toEqual([
      ["stack", "rm", "rp_gate_aaaaaaaa_aaaa_4aaa_8aaa_aaaaaaaaaaaa"],
      [
        "secret",
        "rm",
        "rp-gate-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-private-key-v2",
      ],
    ]);
    expect((prisma.resourcePortalGate.delete as any)).toHaveBeenCalledWith({
      where: { id: readyGate.id },
    });
  });

  it("permanently deletes legacy Revoked Gate records after runtime cleanup", async () => {
    const { service, prisma } = fixture([
      {
        ...readyGate,
        status: "Revoked",
        revokedAt: new Date(),
        networks: [],
      },
    ]);

    await expect(service.reconcile()).resolves.toMatchObject({
      removed: 1,
      failed: 0,
    });
    expect((prisma.resourcePortalGate.delete as any)).toHaveBeenCalledWith({
      where: { id: readyGate.id },
    });
  });

  it("keeps the Gate record when its private key secret cannot be removed", async () => {
    const { service, prisma } = fixture([
      {
        ...readyGate,
        status: "Deleting",
        revokedAt: new Date(),
        networks: [],
      },
    ]);
    service.dockerResults.push(
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "secret is in use by service" },
    );

    await expect(service.reconcile()).resolves.toMatchObject({
      removed: 0,
      failed: 1,
    });
    expect((prisma.resourcePortalGate.delete as any)).not.toHaveBeenCalled();
    expect((prisma.resourcePortalGate.update as any)).toHaveBeenCalledWith({
      where: { id: readyGate.id },
      data: expect.objectContaining({
        status: "Error",
        lastError: expect.stringContaining("secret is in use"),
      }),
    });
  });
  it("deletes a Network record only after the managed Swarm overlay is removed", async () => {
    const deleting = {
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      swarmNetworkName: "rp-network-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      status: "Deleting",
    };
    const { service, runtime, prisma } = fixture([], [deleting]);

    await expect(service.reconcile()).resolves.toMatchObject({
      networksDeleting: 1,
      networksDeleted: 1,
      networkDeleteFailures: 0,
    });
    expect(runtime.removeTenantNetwork).toHaveBeenCalledWith(
      "rp-network-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    );
    expect((prisma.network.delete as any)).toHaveBeenCalledWith({
      where: { id: deleting.id },
    });
  });

  it("keeps a Network in Deleting when Swarm still has active endpoints", async () => {
    const deleting = {
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      swarmNetworkName: "rp-network-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      status: "Deleting",
    };
    const { service, runtime, prisma } = fixture([], [deleting]);
    (runtime.removeTenantNetwork as any).mockResolvedValue({
      success: false,
      changed: false,
      error: "network has active endpoints",
    });

    await expect(service.reconcile()).resolves.toMatchObject({
      networksDeleting: 1,
      networksDeleted: 0,
      networkDeleteFailures: 1,
    });
    expect((prisma.network.delete as any)).not.toHaveBeenCalled();
    expect((prisma.network.update as any)).toHaveBeenCalledWith({
      where: { id: deleting.id },
      data: expect.objectContaining({
        lastError: "network has active endpoints",
      }),
    });
  });

});