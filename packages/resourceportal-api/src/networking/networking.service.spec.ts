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
    deviceVpnDevice: {
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    deviceVpnNetworkAccess: {
      createMany: vi.fn(),
      deleteMany: vi.fn(),
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
    appGroup: {
      findMany: vi.fn().mockResolvedValue([]),
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
    deviceVpnGateway: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    deviceVpnDevice: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
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
    get: vi.fn((key: string, fallback?: string) => {
      if (key === "RESOURCEPORTAL_GATE_ENDPOINT_HOST") return "10.0.0.10";
      if (key === "RESOURCEPORTAL_DEVICE_VPN_ENDPOINT_HOST") return "vpn.example.test";
      if (key === "RESOURCEPORTAL_DEVICE_VPN_PORT") return "51820";
      if (key === "RESOURCEPORTAL_DEVICE_VPN_POOL") return "100.64.0.0/11";
      if (key === "RESOURCEPORTAL_DEVICE_VPN_SERVER_ADDRESS") return "100.64.0.1/11";
      return fallback;
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
  it("includes the deployed App Group network and its real application membership in topology", async () => {
    const { service, prisma } = fixture();
    (prisma.appGroup.findMany as any).mockResolvedValue([
      {
        id: "11111111-1111-4111-8111-111111111111",
        name: "penpot",
        hasPendingChanges: false,
        currentDeploymentVersion: 4,
        singleApps: [
          {
            id: "33333333-3333-4333-8333-333333333333",
            name: "frontend",
            image: "penpot/frontend:latest",
            runtimeState: "Running",
            networkAttachments: [],
          },
          {
            id: "44444444-4444-4444-8444-444444444444",
            name: "backend",
            image: "penpot/backend:latest",
            runtimeState: "Running",
            networkAttachments: [],
          },
        ],
      },
    ]);

    const result = await service.topology(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );

    expect(result.appGroups[0]).toMatchObject({
      id: "11111111-1111-4111-8111-111111111111",
      appGroupNetwork: {
        name: "rp-appgroup-11111111-1111-4111-8111-111111111111",
      },
      singleApps: [
        { id: "33333333-3333-4333-8333-333333333333" },
        { id: "44444444-4444-4444-8444-444444444444" },
      ],
    });
  });

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

  it("creates Device VPN with a one-time private key and tenant-scoped Network access", async () => {
    const { service, prisma, tx } = fixture();
    const tenantId = "11111111-1111-4111-8111-111111111111";
    const networkId = "22222222-2222-4222-8222-222222222222";
    const network = {
      id: networkId,
      tenantId,
      name: "backend",
      cidr: "10.240.10.0/24",
      status: "Ready",
    };
    (prisma.network.findMany as any).mockResolvedValue([network]);
    (prisma.deviceVpnGateway.findUnique as any).mockResolvedValue(null);
    (prisma.deviceVpnGateway.create as any).mockImplementation(({ data }: any) =>
      Promise.resolve({ ...data }),
    );
    (prisma.deviceVpnDevice.findMany as any).mockResolvedValue([]);
    tx.deviceVpnDevice.create.mockImplementation(({ data }: any) =>
      Promise.resolve({
        id: "33333333-3333-4333-8333-333333333333",
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
        networks: [
          {
            networkId,
            network,
          },
        ],
      }),
    );

    const result = await service.createDeviceVpnDevice(
      tenantId,
      { name: "work-laptop", networkIds: [networkId] },
      actor,
    );

    expect(result.device).toMatchObject({
      name: "work-laptop",
      assignedAddress: "100.64.0.2",
      address: "100.64.0.2/32",
      networks: [{ id: networkId, name: "backend", cidr: "10.240.10.0/24" }],
    });
    expect(result.configuration).toMatchObject({
      endpoint: "vpn.example.test:51820",
      address: "100.64.0.2/32",
      allowedIps: ["10.240.10.0/24"],
      privateKeyStored: false,
    });
    expect(result.configuration.wireguardConfig).toContain(
      "AllowedIPs = 10.240.10.0/24",
    );
    expect(tx.deviceVpnDevice.create).toHaveBeenCalledWith({
      data: expect.not.objectContaining({
        privateKey: expect.anything(),
        privateKeyCiphertext: expect.anything(),
      }),
      include: expect.anything(),
    });
    expect(tx.auditLogEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "device_vpn.device.create",
        resourceType: "DeviceVpnDevice",
      }),
    });
  });

  it("revokes only the current user's Device VPN peer", async () => {
    const { service, prisma, tx } = fixture();
    const tenantId = "11111111-1111-4111-8111-111111111111";
    const deviceId = "33333333-3333-4333-8333-333333333333";
    const device = {
      id: deviceId,
      tenantId,
      userId: actor.id,
      name: "work-laptop",
      publicKey: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
      assignedAddress: "100.64.0.2",
      status: "Ready",
      configRevision: 1,
      revokedAt: null,
      networks: [],
    };
    (prisma.deviceVpnDevice.findFirst as any).mockResolvedValue(device);
    tx.deviceVpnDevice.update.mockImplementation(({ data }: any) =>
      Promise.resolve({
        ...device,
        ...data,
        revokedAt: data.revokedAt,
        networks: [],
      }),
    );

    const result = await service.revokeDeviceVpnDevice(
      tenantId,
      deviceId,
      actor,
    );

    expect(result).toMatchObject({
      id: deviceId,
      status: "Revoked",
      revokedAt: expect.any(Date),
    });
    expect(prisma.deviceVpnDevice.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: deviceId, tenantId, userId: actor.id },
      }),
    );
    expect(tx.auditLogEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "device_vpn.device.revoke",
      }),
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

  it("marks a Gate as Deleting, invalidates its token, and audits permanent deletion", async () => {
    const { service, prisma, tx } = fixture();
    const gate = {
      id: "77777777-7777-4777-8777-777777777777",
      tenantId: "11111111-1111-4111-8111-111111111111",
      name: "office",
      status: "Ready",
      revokedAt: null,
      agentTokenHash: "token-hash",
      configRevision: 3,
      lanAddresses: [],
      lanCidrs: [],
    };
    (prisma.resourcePortalGate.findFirst as any).mockResolvedValue(gate);
    tx.resourcePortalGate.update.mockImplementation(({ data }: any) =>
      Promise.resolve({ ...gate, ...data, revokedAt: data.revokedAt }),
    );

    const result = await service.revokeGate(
      "11111111-1111-4111-8111-111111111111",
      gate.id,
      actor,
    );

    expect(result).toMatchObject({
      id: gate.id,
      status: "Deleting",
      revokedAt: expect.any(Date),
    });
    expect(tx.resourcePortalGate.update).toHaveBeenCalledWith({
      where: { id: gate.id },
      data: expect.objectContaining({
        status: "Deleting",
        agentTokenHash: null,
        configRevision: { increment: 1 },
        updatedBy: actor.id,
        revokedAt: expect.any(Date),
      }),
    });
    expect(tx.resourcePortalGateEnrollment.updateMany).toHaveBeenCalledWith({
      where: { gateId: gate.id, usedAt: null },
      data: { usedAt: expect.any(Date) },
    });
    expect(tx.auditLogEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "gate.delete.requested",
        resourceType: "ResourcePortalGate",
        resourceId: gate.id,
      }),
    });
  });

  it("excludes Gates pending permanent deletion from tenant Gate listings", async () => {
    const { service, prisma } = fixture();

    await service.listGates("11111111-1111-4111-8111-111111111111");

    expect(prisma.resourcePortalGate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: "11111111-1111-4111-8111-111111111111",
          revokedAt: null,
        },
      }),
    );
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

  it("stores eBGP configuration and derives advertised prefixes only from Gate attachments", async () => {
    const { service, prisma, tx } = fixture();
    const gate = {
      id: "88888888-8888-4888-8888-888888888888",
      tenantId: "11111111-1111-4111-8111-111111111111",
      name: "office",
      revokedAt: null,
      lanAddresses: ["192.168.50.2"],
      lanCidrs: ["192.168.50.0/24"],
      configRevision: 3,
    };
    (prisma.resourcePortalGate.findFirst as any).mockResolvedValue(gate);
    tx.resourcePortalGate.update.mockImplementation(({ data }: any) =>
      Promise.resolve({
        ...gate,
        ...data,
        routeAdvertisementMode: "BGP",
        bgpLocalAsn: BigInt(65050),
        bgpRouterAddress: "192.168.50.1",
        bgpRouterAsn: BigInt(65001),
        bgpSourceAddress: "192.168.50.2",
        bgpHoldTimeSeconds: 90,
        networks: [
          { network: { id: "network-1", name: "backend", cidr: "10.240.10.0/24" } },
          { network: { id: "network-2", name: "db", cidr: "10.240.20.0/24" } },
        ],
      }),
    );

    const result = await service.updateGateRouting(
      "11111111-1111-4111-8111-111111111111",
      gate.id,
      {
        mode: "BGP",
        localAsn: 65050,
        routerAddress: "192.168.50.1",
        routerAsn: 65001,
        sourceAddress: "192.168.50.2",
        holdTimeSeconds: 90,
      },
      actor,
    );

    expect(tx.resourcePortalGate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: gate.id },
        data: expect.objectContaining({
          routeAdvertisementMode: "BGP",
          bgpLocalAsn: BigInt(65050),
          bgpRouterAddress: "192.168.50.1",
          bgpRouterAsn: BigInt(65001),
          bgpSourceAddress: "192.168.50.2",
          configRevision: { increment: 1 },
        }),
      }),
    );
    expect(result).toMatchObject({
      routeAdvertisementMode: "BGP",
      bgpLocalAsn: 65050,
      bgpRouterAsn: 65001,
      advertisedCidrs: ["10.240.10.0/24", "10.240.20.0/24"],
    });
    expect(tx.auditLogEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "gate.routing.update",
        resourceType: "ResourcePortalGate",
        resourceId: gate.id,
      }),
    });
  });

  it("requires enrolled LAN addressing before BGP can be enabled", async () => {
    const { service, prisma } = fixture();
    (prisma.resourcePortalGate.findFirst as any).mockResolvedValue({
      id: "88888888-8888-4888-8888-888888888888",
      name: "office",
      revokedAt: null,
      lanAddresses: [],
      lanCidrs: [],
    });

    await expect(
      service.updateGateRouting(
        "11111111-1111-4111-8111-111111111111",
        "88888888-8888-4888-8888-888888888888",
        {
          mode: "BGP",
          localAsn: 65050,
          routerAddress: "192.168.50.1",
          routerAsn: 65001,
        },
        actor,
      ),
    ).rejects.toMatchObject({
      message:
        "ResourcePortalGate must report its LAN addressing before BGP can be enabled",
    });
  });

  it("rejects BGP peers outside LAN CIDRs reported by the Gate", async () => {
    const { service, prisma } = fixture();
    (prisma.resourcePortalGate.findFirst as any).mockResolvedValue({
      id: "88888888-8888-4888-8888-888888888888",
      name: "office",
      revokedAt: null,
      lanAddresses: ["192.168.50.2"],
      lanCidrs: ["192.168.50.0/24"],
    });

    await expect(
      service.updateGateRouting(
        "11111111-1111-4111-8111-111111111111",
        "88888888-8888-4888-8888-888888888888",
        {
          mode: "BGP",
          localAsn: 65050,
          routerAddress: "192.168.60.1",
          routerAsn: 65001,
        },
        actor,
      ),
    ).rejects.toMatchObject({
      message: "BGP router address must belong to a LAN CIDR reported by this Gate",
    });
  });

  it("returns export-only BGP desired state to the Gate agent", async () => {
    const { service, prisma } = fixture();
    const token = "agent-secret";
    (prisma.resourcePortalGate.findUnique as any).mockResolvedValue({
      id: "88888888-8888-4888-8888-888888888888",
      agentTokenHash: createHash("sha256").update(token).digest("hex"),
      revokedAt: null,
    });
    (prisma.resourcePortalGate.findUniqueOrThrow as any).mockResolvedValue({
      id: "88888888-8888-4888-8888-888888888888",
      serverPublicKey: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
      serverListenPort: 52000,
      clientTunnelAddress: "100.96.0.2/30",
      configRevision: 7,
      revokedAt: null,
      routeAdvertisementMode: "BGP",
      bgpLocalAsn: BigInt(65050),
      bgpRouterAddress: "192.168.50.1",
      bgpRouterAsn: BigInt(65001),
      bgpSourceAddress: "192.168.50.2",
      bgpHoldTimeSeconds: 90,
      networks: [
        { network: { id: "network-1", name: "backend", cidr: "10.240.20.0/24" } },
        { network: { id: "network-2", name: "api", cidr: "10.240.10.0/24" } },
      ],
    });

    const result = await service.gateAgentConfig(`Bearer ${token}`);

    expect(result.routeAdvertisement).toEqual({
      mode: "BGP",
      localAsn: 65050,
      routerAddress: "192.168.50.1",
      routerAsn: 65001,
      sourceAddress: "192.168.50.2",
      holdTimeSeconds: 90,
      advertisedCidrs: ["10.240.10.0/24", "10.240.20.0/24"],
    });
    expect(result).not.toHaveProperty("learnedRoutes");
  });

});