/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/unbound-method, @typescript-eslint/require-await */
import { ConfigService } from "@nestjs/config";
import { ConflictException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../prisma/prisma.service";
import type { EncryptionService } from "../security/encryption.service";
import type { AuthenticatedUser } from "../auth/types";
import { NetworkingService } from "./networking.service";
import type { WireGuardKeyService } from "./wireguard-key.service";

const actor: AuthenticatedUser = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  email: "admin@example.com",
  displayName: "Admin",
  status: "Active" as any,
};

function fixture(overrides: Record<string, any> = {}) {
  const tx = {
    network: {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    networkAttachment: {
      create: vi.fn(),
      delete: vi.fn(),
    },
    resourcePortalGate: {
      create: vi.fn(),
      update: vi.fn(),
    },
    resourcePortalGateEnrollment: {
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    gateNetworkAttachment: {
      create: vi.fn(),
      delete: vi.fn(),
    },
    appGroup: {
      update: vi.fn().mockResolvedValue({}),
    },
    tenant: {
      findUnique: vi.fn().mockResolvedValue({ name: "Tenant" }),
    },
    auditLogEntry: {
      create: vi.fn().mockResolvedValue({}),
    },
  };
  const prisma = {
    network: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirstOrThrow: vi.fn(),
      findFirst: vi.fn(),
    },
    networkAttachment: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
    },
    singleApp: {
      findFirst: vi.fn(),
    },
    resourcePortalGate: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
    },
    resourcePortalGateEnrollment: {
      findUnique: vi.fn(),
    },
    gateNetworkAttachment: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
    },
    tenant: {
      findUnique: vi.fn().mockResolvedValue({ id: "tenant-1" }),
    },
    $transaction: vi.fn(async (callback: any) =>
      typeof callback === "function" ? callback(tx) : Promise.all(callback),
    ),
    ...overrides,
  } as unknown as PrismaService;
  const config = {
    get: vi.fn((key: string) => {
      if (key === "RESOURCEPORTAL_GATE_ENDPOINT_HOST") return "10.0.0.10";
      return undefined;
    }),
  } as unknown as ConfigService;
  const encryption = {
    encrypt: vi.fn((value: string) => `encrypted:${value}`),
    decrypt: vi.fn((value: string) => value),
  } as unknown as EncryptionService;
  const wireGuard = {
    generateKeyPair: vi.fn().mockReturnValue({
      privateKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      publicKey: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
    }),
    isPublicKey: vi.fn().mockReturnValue(true),
  } as unknown as WireGuardKeyService;

  return {
    tx,
    prisma,
    encryption,
    wireGuard,
    service: new NetworkingService(prisma, config, encryption, wireGuard),
  };
}

describe("NetworkingService control plane", () => {
  it("creates a Network with separate stable and overlay CIDRs", async () => {
    const { service, tx } = fixture();
    tx.network.create.mockImplementation(({ data }: any) =>
      Promise.resolve({ ...data, createdAt: new Date(), updatedAt: new Date() }),
    );

    const result = await service.createNetwork(
      "11111111-1111-4111-8111-111111111111",
      { name: "backend" },
      actor,
    );

    expect(result.cidr).toBe("10.240.0.0/24");
    expect(result.overlayCidr).toBe("10.200.0.0/24");
    expect(result.swarmNetworkName).toMatch(/^rp-network-/);
    expect(tx.auditLogEntry.create).toHaveBeenCalled();
  });

  it("attaches an app with a stable address and marks its App Group draft pending", async () => {
    const { service, prisma, tx } = fixture();
    (prisma.network.findFirst as any).mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      tenantId: "11111111-1111-4111-8111-111111111111",
      name: "backend",
      cidr: "10.240.10.0/24",
    });
    (prisma.singleApp.findFirst as any).mockResolvedValue({
      id: "33333333-3333-4333-8333-333333333333",
      name: "api",
      appGroupId: "44444444-4444-4444-8444-444444444444",
      appGroup: { name: "services" },
    });
    tx.networkAttachment.create.mockResolvedValue({
      id: "55555555-5555-4555-8555-555555555555",
      networkId: "22222222-2222-4222-8222-222222222222",
      singleAppId: "33333333-3333-4333-8333-333333333333",
      address: "10.240.10.10",
    });

    const result = await service.attachApplication(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      { singleAppId: "33333333-3333-4333-8333-333333333333" },
      actor,
    );

    expect(result).toMatchObject({
      address: "10.240.10.10",
      deploymentRequired: true,
    });
    expect(tx.appGroup.update).toHaveBeenCalledWith({
      where: { id: "44444444-4444-4444-8444-444444444444" },
      data: {
        hasPendingChanges: true,
        runtimeDraftRevision: { increment: 1 },
        updatedBy: actor.id,
      },
    });
  });

  it("creates a Gate with encrypted RP-side key, unique port/tunnel and one-time enrollment", async () => {
    const { service, tx, encryption } = fixture();
    tx.resourcePortalGate.create.mockImplementation(({ data }: any) =>
      Promise.resolve({ ...data, lanAddresses: [], lanCidrs: [] }),
    );

    const result = await service.createGate(
      "11111111-1111-4111-8111-111111111111",
      { name: "office" },
      actor,
    );

    expect(result.gate.serverListenPort).toBe(52000);
    expect(result.gate.serverTunnelAddress).toBe("100.96.0.1/30");
    expect(result.gate.clientTunnelAddress).toBe("100.96.0.2/30");
    expect(result.gate).not.toHaveProperty("serverPrivateKeyCiphertext");
    expect(encryption.encrypt).toHaveBeenCalledWith(
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    );
    expect(tx.resourcePortalGateEnrollment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        gateId: expect.any(String),
        tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    });
    expect(result.enrollment.token).toBeTruthy();
  });

  it("exchanges an enrollment token for an agent token stored only as SHA-256", async () => {
    const { service, prisma, tx } = fixture();
    const enrollmentToken = "enrollment-secret";
    (prisma.resourcePortalGateEnrollment.findUnique as any).mockResolvedValue({
      id: "66666666-6666-4666-8666-666666666666",
      gateId: "77777777-7777-4777-8777-777777777777",
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      gate: {
        id: "77777777-7777-4777-8777-777777777777",
        revokedAt: null,
      },
    });
    tx.resourcePortalGate.update.mockImplementation(({ data }: any) =>
      Promise.resolve({
        id: "77777777-7777-4777-8777-777777777777",
        ...data,
        serverPublicKey: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
        serverListenPort: 52001,
        clientTunnelAddress: "100.96.0.6/30",
        configRevision: 2,
        revokedAt: null,
        networks: [],
      }),
    );

    const result = await service.enrollGate({
      token: enrollmentToken,
      publicKey: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=",
      lanAddresses: ["192.168.50.2"],
      lanCidrs: ["192.168.50.0/24"],
      agentVersion: "test",
    });

    const update = tx.resourcePortalGate.update.mock.calls[0]?.[0];
    expect(update.data.agentTokenHash).toBe(
      createHash("sha256").update(result.agentToken).digest("hex"),
    );
    expect(update.data.agentTokenHash).not.toContain(result.agentToken);
    expect(result).toMatchObject({
      endpoint: "10.0.0.10:52001",
      tunnelAddress: "100.96.0.6/30",
      allowedIps: [],
    });
  });

  it("rejects application attachment when the app is outside the Network tenant", async () => {
    const { service, prisma } = fixture();
    (prisma.network.findFirst as any).mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      tenantId: "11111111-1111-4111-8111-111111111111",
      name: "backend",
      cidr: "10.240.10.0/24",
    });
    (prisma.singleApp.findFirst as any).mockResolvedValue(null);

    await expect(
      service.attachApplication(
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
        { singleAppId: "33333333-3333-4333-8333-333333333333" },
        actor,
      ),
    ).rejects.toMatchObject({ message: "Application not found" });
  });

  it("rejects Gate attachment when an RP Network overlaps the Gate LAN", async () => {
    const { service, prisma } = fixture();
    (prisma.resourcePortalGate.findFirst as any).mockResolvedValue({
      id: "88888888-8888-4888-8888-888888888888",
      name: "office",
      revokedAt: null,
      lanCidrs: ["192.168.10.0/24"],
    });
    (prisma.network.findFirst as any).mockResolvedValue({
      id: "99999999-9999-4999-8999-999999999999",
      name: "backend",
      cidr: "192.168.10.0/24",
    });

    await expect(
      service.attachGateNetwork(
        "11111111-1111-4111-8111-111111111111",
        "88888888-8888-4888-8888-888888888888",
        { networkId: "99999999-9999-4999-8999-999999999999" },
        actor,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
  it("marks an empty Network as Deleting instead of dropping the DB record immediately", async () => {
    const { service, prisma, tx } = fixture();
    (prisma.network.findFirst as any).mockResolvedValue({
      id: "abababab-abab-4bab-8bab-abababababab",
      tenantId: "11111111-1111-4111-8111-111111111111",
      name: "retired",
      cidr: "10.240.30.0/24",
      overlayCidr: "10.200.30.0/24",
      revision: 4,
      _count: { attachments: 0, gateAttachments: 0 },
    });
    tx.network.update.mockResolvedValue({
      id: "abababab-abab-4bab-8bab-abababababab",
      status: "Deleting",
      revision: 5,
    });

    await expect(
      service.deleteNetwork(
        "11111111-1111-4111-8111-111111111111",
        "abababab-abab-4bab-8bab-abababababab",
        actor,
      ),
    ).resolves.toMatchObject({
      deleting: true,
      network: { status: "Deleting", revision: 5 },
    });

    expect(tx.network.delete).not.toHaveBeenCalled();
    expect(tx.network.update).toHaveBeenCalledWith({
      where: { id: "abababab-abab-4bab-8bab-abababababab" },
      data: {
        status: "Deleting",
        revision: { increment: 1 },
        updatedBy: actor.id,
        lastError: null,
      },
    });
  });

  it("rejects new attachments to a Network already being deleted", async () => {
    const { service, prisma } = fixture();
    (prisma.network.findFirst as any).mockResolvedValue({
      id: "abababab-abab-4bab-8bab-abababababab",
      tenantId: "11111111-1111-4111-8111-111111111111",
      name: "retired",
      cidr: "10.240.30.0/24",
      status: "Deleting",
    });

    await expect(
      service.attachApplication(
        "11111111-1111-4111-8111-111111111111",
        "abababab-abab-4bab-8bab-abababababab",
        { singleAppId: "33333333-3333-4333-8333-333333333333" },
        actor,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

});