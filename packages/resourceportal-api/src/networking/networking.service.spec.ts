/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/unbound-method, @typescript-eslint/require-await */
import { ConfigService } from "@nestjs/config";
import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
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

function fixture(overrides: Record<string, any> = {}, maintenance = false) {
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
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
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
      if (key === "PLATFORM_MAINTENANCE_MODE") return maintenance ? "true" : undefined;
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


  it.each([
    { name: "undeployed App Group", group: { currentDeploymentVersion: null }, blocker: "AppGroupNotDeployed" },
    { name: "deleting App Group", group: { status: "Deleting" }, blocker: "AppGroupDeleting" },
    { name: "errored App Group", group: { status: "Error" }, blocker: "AppGroupError" },
    { name: "stopped App Group", group: { runtimeState: "Stopped" }, blocker: "AppGroupStopped" },
    { name: "suspended tenant", tenant: { status: "Suspended" }, blocker: "TenantSuspended" },
    { name: "tenant with no credit", tenant: { billing: { balance: new Prisma.Decimal("0") } }, blocker: "BillingSuspended" },
    { name: "platform maintenance", maintenance: true, blocker: "PlatformMaintenance" },
  ])("does not report a running workload when blocked by $name", async ({ group, tenant, maintenance, blocker }) => {
    const { service, prisma } = fixture({}, maintenance ?? false);
    (prisma.appGroup.findMany as any).mockResolvedValue([{
      id: "group-1", name: "production", status: "Active",
      runtimeState: "Running", currentDeploymentVersion: 1,
      hasPendingChanges: false,
      tenant: { status: "Active", billing: { balance: new Prisma.Decimal("10") }, ...tenant },
      singleApps: [{
        id: "app-1", name: "frontend", image: "frontend:1",
        runtimeState: "Running", pendingDeletion: false,
        networkAttachments: [], httpEndpoints: [],
      }],
      ...group,
    }]);

    const result = await service.topology("tenant-1");
    expect(result.appGroups[0]).toMatchObject({
      effectiveRuntimeState: "Stopped",
      runtimeBlockers: expect.arrayContaining([blocker]),
      singleApps: [{
        effectiveRuntimeState: "Stopped",
        runtimeBlockers: expect.arrayContaining([blocker]),
      }],
    });
    expect(result.appGroups[0]).not.toHaveProperty("tenant");
  });

  it("keeps a healthy group's state and applies per-application blockers independently", async () => {
    const { service, prisma } = fixture();
    (prisma.appGroup.findMany as any).mockResolvedValue([{
      id: "group-1", name: "production", status: "Active",
      runtimeState: "Running", currentDeploymentVersion: 1,
      hasPendingChanges: false,
      tenant: { status: "Active", billing: { balance: new Prisma.Decimal("10") } },
      singleApps: [
        { id: "app-running", name: "running", runtimeState: "Running", pendingDeletion: false, networkAttachments: [], httpEndpoints: [] },
        { id: "app-stopped", name: "stopped", runtimeState: "Stopped", pendingDeletion: false, networkAttachments: [], httpEndpoints: [] },
      ],
    }]);
    const result = await service.topology("tenant-1");
    expect(result.appGroups[0].effectiveRuntimeState).toBe("Running");
    expect(result.appGroups[0].runtimeBlockers).toEqual([]);
    expect(result.appGroups[0].singleApps[0].effectiveRuntimeState).toBe("Running");
    expect(result.appGroups[0].singleApps[1]).toMatchObject({
      effectiveRuntimeState: "Stopped",
      runtimeBlockers: ["SingleAppStopped"],
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
        remoteLanAttachments: [],
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
    expect(result.gate).not.toHaveProperty("serverTunnelAddress");
    expect(result.gate).not.toHaveProperty("clientTunnelAddress");
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
        serverTunnelAddress: "100.96.0.5/30",
        configRevision: 2,
        revokedAt: null,
        networks: [],
      }),
    );

    const result = await service.enrollGate({
      token: enrollmentToken,
      publicKey: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=",
      agentVersion: "gate-l2-v1",
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

describe("RP Gate LAN Attachments-only machine token policy", () => {
  const gateToken = "gate-agent-test-token";
  const tenantId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const gateId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const currentGate = {
    id: gateId, tenantId, agentTokenHash: createHash("sha256").update(gateToken).digest("hex"),
    revokedAt: null, agentVersion: "gate-l2-v1", status:"Ready",
    serverPublicKey: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
    serverListenPort:52000, serverTunnelAddress:"100.96.0.1/30",
    clientTunnelAddress:"100.96.0.2/30", configRevision:3,
    remoteLanAttachments: [{
      id:"aaaaaaaa-bbbb-4ccc-8ddd-111111111111", tenantId, gateId,
      singleAppId:"aaaaaaaa-bbbb-4ccc-8ddd-222222222222",
      networkId:"aaaaaaaa-bbbb-4ccc-8ddd-333333333333",
      lanInterface:"eth1", lanCidr:"192.168.50.0/24",
      macAddress:"02:aa:bb:cc:dd:ee",status:"Active",
    }],
  };
  it("rejects unknown machine tokens without leaking attachment state",async()=>{
    const {service,prisma}=fixture();
    (prisma.resourcePortalGate.findUnique as any).mockResolvedValue(null);
    await expect(service.gateHeartbeat("Bearer invalid-machine-token",{
      agentVersion:"gate-l2-v1",
    })).rejects.toThrow("Invalid or revoked ResourcePortalGate token");
  });
  it("requires bearer token on each heartbeat",async()=>{
    const {service}=fixture();
    await expect(service.gateHeartbeat(undefined,{agentVersion:"gate-l2-v1"}))
      .rejects.toThrow("ResourcePortalGate bearer token is required");
  });
  it("requires certified L2 protocol and never returns Site-level routes",async()=>{
    const {service,prisma}=fixture();
    (prisma.resourcePortalGate.findUnique as any).mockResolvedValue(currentGate);
    (prisma.resourcePortalGate.update as any).mockResolvedValue(currentGate);
    await expect(service.gateHeartbeat("Bearer "+gateToken,{agentVersion:"gate-shell-v3"}))
      .rejects.toThrow(/certified LAN Attachment/);
    const desired=await service.gateHeartbeat("Bearer "+gateToken,{agentVersion:"gate-l2-v1"});
    expect(desired.lanAttachmentProtocol).toBe(1);
    expect(desired.allowedIps).toEqual(["100.96.0.1/32"]);
    expect(desired.lanAttachments).toEqual([expect.objectContaining({
      singleAppId:currentGate.remoteLanAttachments[0].singleAppId,
      macAddress:"02:aa:bb:cc:dd:ee",
    })]);
    expect(desired).not.toHaveProperty("bgp");
    expect(desired).not.toHaveProperty("applicationLanPolicies");
  });
  it("stores only bounded diagnostics and distinguishes authenticated API filtering",async()=>{
    const {service,prisma}=fixture();
    (prisma.resourcePortalGate.findUnique as any).mockResolvedValue(currentGate);
    (prisma.resourcePortalGate.update as any).mockResolvedValue(currentGate);
    (prisma.remoteLanAttachment as any)={findMany:vi.fn().mockResolvedValue([])};
    const now=Date.now();
    const proof={source:"gate-agent" as const,attachmentId:currentGate.remoteLanAttachments[0].id,
      tenantId,gateId,singleAppId:currentGate.remoteLanAttachments[0].singleAppId,
      configurationRevision:4,macAddress:"02:aa:bb:cc:dd:ee",observedAtMs:now-1000,
      handshakeAtMs:now-1000,gatewayTunnelOwned:true,bridgeOwned:true,macLearnedOnTunnel:true};
    await service.gateHeartbeat("Bearer "+gateToken,{agentVersion:"gate-l2-v2",
      lanAttachmentProofs:[proof],lanProofDiagnostic:{reasonCode:"ok",rawCount:1,errorCode:"none"}});
    expect((prisma.resourcePortalGate.update as any).mock.calls.at(-1)[0].data.observedL2Diagnostic)
      .toEqual({reasonCode:"proof_filtered_by_api",rawCount:1,acceptedCount:0,errorCode:"none"});
    await service.gateHeartbeat("Bearer "+gateToken,{agentVersion:"gate-l2-v2",
      lanAttachmentProofs:[],lanProofDiagnostic:{reasonCode:"collector_error",rawCount:0,
        errorCode:"collector_execution_failed"}});
    expect((prisma.resourcePortalGate.update as any).mock.calls.at(-1)[0].data.observedL2Diagnostic)
      .toEqual({reasonCode:"collector_error",rawCount:0,acceptedCount:0,
        errorCode:"collector_execution_failed"});
    await service.gateHeartbeat("Bearer "+gateToken,{agentVersion:"gate-l2-v2",lanAttachmentProofs:[]});
    expect((prisma.resourcePortalGate.update as any).mock.calls.at(-1)[0].data.observedL2Diagnostic)
      .toEqual({reasonCode:"unknown_legacy_agent",rawCount:0,acceptedCount:0,errorCode:"none"});

  });
  it("accepts authenticated heartbeat during 120s rekey grace but rejects >=150s and wrong peer",async()=>{
    const {service,prisma}=fixture();
    const now=Date.now();
    (prisma.resourcePortalGate.findUnique as any).mockResolvedValue(currentGate);
    (prisma.resourcePortalGate.update as any).mockResolvedValue(currentGate);
    (prisma.remoteLanAttachment as any)={findMany:vi.fn().mockResolvedValue([{
      id:currentGate.remoteLanAttachments[0].id,
      singleAppId:currentGate.remoteLanAttachments[0].singleAppId,
      configurationRevision:4,macAddress:"02:aa:bb:cc:dd:ee",
    }])};
    const payload=(age:number)=>({agentVersion:"gate-l2-v2" as const,
      lanAttachmentProofs:[{
        source:"gate-agent" as const,
        attachmentId:currentGate.remoteLanAttachments[0].id,
        tenantId,gateId,singleAppId:currentGate.remoteLanAttachments[0].singleAppId,
        configurationRevision:4,macAddress:"02:aa:bb:cc:dd:ee",
        observedAtMs:now-1000,handshakeAtMs:now-age*1000,
        gatewayTunnelOwned:true,bridgeOwned:true,macLearnedOnTunnel:true,
      }]});
    for(const age of [32,39,42,44])
      await expect(service.gateHeartbeat("Bearer "+gateToken,{
        ...payload(120),lanAttachmentProofs:[{...payload(120).lanAttachmentProofs[0],observedAtMs:now-age*1000}],
      })).resolves.toBeDefined();
    await expect(service.gateHeartbeat("Bearer "+gateToken,{
      ...payload(120),lanAttachmentProofs:[{...payload(120).lanAttachmentProofs[0],observedAtMs:now-46_000}],
    })).rejects.toThrow(/Untrusted or stale Gate attachment proof/);
    for(const age of [89,90,120])
      await expect(service.gateHeartbeat("Bearer "+gateToken,payload(age))).resolves.toBeDefined();
    for(const age of [150,180])
      await expect(service.gateHeartbeat("Bearer "+gateToken,payload(age))).rejects.toThrow(
        /Untrusted or stale Gate attachment proof/);
    await expect(service.gateHeartbeat("Bearer "+gateToken,{
      ...payload(120),lanAttachmentProofs:[{...payload(120).lanAttachmentProofs[0],tenantId:gateId}],
    })).rejects.toThrow(/Untrusted or stale Gate attachment proof/);
  });
  it("never publishes grants after Gate token revocation",async()=>{
    const {service,prisma}=fixture();
    (prisma.resourcePortalGate.findUnique as any).mockResolvedValue({...currentGate,revokedAt:new Date()});
    await expect(service.gateAgentConfig("Bearer "+gateToken))
      .rejects.toThrow();
  });
  it("preserves Device VPN separate machine-token validation",async()=>{
    const {service,prisma}=fixture();
    (prisma.deviceVpnGateway.findUnique as any).mockResolvedValue(null);
    await expect(service.deviceVpnRuntimeHeartbeat("Bearer invalid-device-token",{peers:[]}))
      .rejects.toThrow("Invalid Device VPN runtime token");
  });
});
