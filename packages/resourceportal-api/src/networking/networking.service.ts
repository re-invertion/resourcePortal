import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AuthenticatedUser } from "../auth/types";
import { appGroupNetworkName } from "../internal/traefik-routing";
import { appGroupRuntimeBlockers, singleAppRuntimeBlockers } from "../app-groups/app-groups.view";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "../security/encryption.service";
import type { AttachNetworkDto } from "./dto/attach-network.dto";
import type { CreateGateDto } from "./dto/create-gate.dto";
import type { CreateDeviceVpnDeviceDto } from "./dto/create-device-vpn-device.dto";
import type { UpdateDeviceVpnDeviceDto } from "./dto/update-device-vpn-device.dto";
import type { DeviceVpnRuntimeHeartbeatDto } from "./dto/device-vpn-runtime-heartbeat.dto";
import type { CreateNetworkDto } from "./dto/create-network.dto";
import type { GateEnrollDto } from "./dto/gate-enroll.dto";
import type { GateHeartbeatDto } from "./dto/gate-heartbeat.dto";
import {verifiedManagedLan} from "./remote-lan-addressing";
import type { UpdateNetworkDto } from "./dto/update-network.dto";
import {
  DEFAULT_GATE_TUNNEL_POOL,
  DEFAULT_DEVICE_VPN_POOL,
  DEFAULT_NETWORK_POOL,
  DEFAULT_NETWORK_PREFIX,
  DEFAULT_OVERLAY_POOL,
  cidrsOverlap,
  containsIpv4,
  intToIpv4,
  isPrivateIpv4Cidr,
  nextAvailableApplicationAddress,
  nextAvailableDeviceVpnAddress,
  nextAvailableGateTunnel,
  nextAvailableNetworkCidr,
  parseIpv4Cidr,
} from "./network-addressing";
import { WireGuardKeyService } from "./wireguard-key.service";

const ENROLLMENT_TTL_MS = 30 * 60 * 1000;
const GATE_PORT_MIN = 52000;
const GATE_PORT_MAX = 52999;

@Injectable()
export class NetworkingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly encryption: EncryptionService,
    private readonly wireGuard: WireGuardKeyService,
  ) {}

  async topologyChangeSnapshot(
    tenantId: string,
    input:
      | { action: "APP_ATTACH"; networkId: string; singleAppId: string }
      | { action: "APP_DETACH"; networkId: string; attachmentId: string },
  ) {
    switch (input.action) {
      case "APP_ATTACH": {
        const [network, singleApp, existingAttachment] = await Promise.all([
          this.prisma.network.findFirst({
            where: { id: input.networkId, tenantId },
            select: { id: true, revision: true, cidr: true },
          }),
          this.prisma.singleApp.findFirst({
            where: {
              id: input.singleAppId,
              pendingDeletion: false,
              appGroup: { tenantId },
            },
            select: { id: true, appGroupId: true },
          }),
          this.prisma.networkAttachment.findFirst({
            where: {
              networkId: input.networkId,
              singleAppId: input.singleAppId,
              network: { tenantId },
            },
            select: { id: true, address: true },
          }),
        ]);
        if (!network) throw new NotFoundException("Network not found");
        if (!singleApp) throw new NotFoundException("Application not found");
        return {
          networkRevision: network.revision,
          networkCidr: network.cidr,
          appGroupId: singleApp.appGroupId,
          existingAttachment,
        };
      }
      case "APP_DETACH": {
        const [network, attachment] = await Promise.all([
          this.prisma.network.findFirst({
            where: { id: input.networkId, tenantId },
            select: { id: true, revision: true },
          }),
          this.prisma.networkAttachment.findFirst({
            where: {
              id: input.attachmentId,
              networkId: input.networkId,
              network: { tenantId },
            },
            select: {
              id: true,
              address: true,
              singleAppId: true,
              singleApp: { select: { appGroupId: true } },
            },
          }),
        ]);
        if (!network) throw new NotFoundException("Network not found");
        if (!attachment) throw new NotFoundException("Network attachment not found");
        return {
          networkRevision: network.revision,
          attachment,
        };
      }
    }
  }

  async topology(tenantId: string) {
    const platformMaintenance = ["1", "true", "yes", "on"].includes(
      (this.config.get<string>("PLATFORM_MAINTENANCE_MODE") ?? "").toLowerCase(),
    );
    const [networks, gates, appGroups] = await Promise.all([
      this.prisma.network.findMany({
        where: { tenantId },
        orderBy: { name: "asc" },
        include: {
          attachments: {
            orderBy: { createdAt: "asc" },
            include: {
              singleApp: {
                select: {
                  id: true,
                  name: true,
                  appGroup: {
                    select: {
                      id: true,
                      name: true,
                      hasPendingChanges: true,
                    },
                  },
                },
              },
            },
          },
        },
      }),
      this.prisma.resourcePortalGate.findMany({
        where: { tenantId, revokedAt: null },
        orderBy: { name: "asc" },
      }),
      this.prisma.appGroup.findMany({
        where: { tenantId },
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          hasPendingChanges: true,
          status: true,
          runtimeState: true,
          currentDeploymentVersion: true,
          tenant: {
            select: {
              status: true,
              billing: { select: { balance: true } },
            },
          },
          singleApps: {
            where: { pendingDeletion: false },
            orderBy: { name: "asc" },
            select: {
              id: true,
              name: true,
              image: true,
              runtimeState: true,
              pendingDeletion: true,
              httpEndpoints: {
                select: {
                  id: true,
                  protocolMode: true,
                  domains: { select: { hostname: true, tlsEnabled: true, dnsStatus: true } },
                },
              },
              networkAttachments: {
                orderBy: { createdAt: "asc" },
                select: {
                  id: true,
                  networkId: true,
                  address: true,
                },
              },
            },
          },
        },
      }),
    ]);

    return {
      networks,
      gates: gates.map((gate) => this.publicGate(gate)),
      appGroups: appGroups.map(({ tenant, ...appGroup }) => {
        // Match the runtime blockers used by standard App Group views; never
        // expose tenant billing details in the topology response.
        const runtimeBlockers = appGroupRuntimeBlockers(
          { ...appGroup, tenant },
          { platformMaintenance },
        );
        return {
          ...appGroup,
          effectiveRuntimeState:
            runtimeBlockers.length > 0 ? "Stopped" : appGroup.runtimeState,
          runtimeBlockers,
          singleApps: appGroup.singleApps.map((app) => {
            const appBlockers = [
              ...runtimeBlockers,
              ...singleAppRuntimeBlockers(app),
            ];
            return {
              ...app,
              effectiveRuntimeState:
                appBlockers.length > 0 ? "Stopped" : app.runtimeState,
              runtimeBlockers: appBlockers,
            };
          }),
          appGroupNetwork:
            appGroup.currentDeploymentVersion === null
              ? null
              : { name: appGroupNetworkName(appGroup.id) },
        };
      }),
    };
  }

  async listNetworks(tenantId: string) {
    return this.prisma.network.findMany({
      where: { tenantId },
      orderBy: { name: "asc" },
      include: {
        attachments: {
          orderBy: { createdAt: "asc" },
          include: {
            singleApp: {
              select: {
                id: true,
                name: true,
                appGroup: { select: { id: true, name: true } },
              },
            },
          },
        },
      },
    });
  }

  async createNetwork(
    tenantId: string,
    dto: CreateNetworkDto,
    actor: AuthenticatedUser,
  ) {
    const existing = await this.prisma.network.findMany({
      select: { cidr: true, overlayCidr: true },
    });
    const cidr = this.resolveNetworkCidr(dto.cidr, existing);
    const overlayCidr = nextAvailableNetworkCidr(
      existing.flatMap((network) => [network.cidr, network.overlayCidr, cidr]),
      this.overlayPool(),
      DEFAULT_NETWORK_PREFIX,
    );
    if (!overlayCidr) {
      throw new ConflictException("No free ResourcePortal overlay CIDR is available");
    }

    const id = randomUUID();
    try {
      return await this.prisma.$transaction(async (tx) => {
        const network = await tx.network.create({
          data: {
            id,
            tenantId,
            name: dto.name,
            description: dto.description?.trim() || null,
            cidr,
            overlayCidr,
            swarmNetworkName: `rp-network-${id}`,
            status: "Provisioning",
            createdBy: actor.id,
            updatedBy: actor.id,
          },
        });
        await this.audit(tx, tenantId, actor, {
          action: "network.create",
          resourceType: "Network",
          resourceId: network.id,
          resourceName: network.name,
          changes: { cidr, overlayCidr },
        });
        return network;
      });
    } catch (error) {
      this.rethrowKnownConflict(error, "Network name or address space already exists");
      throw error;
    }
  }

  async updateNetwork(
    tenantId: string,
    networkId: string,
    dto: UpdateNetworkDto,
    actor: AuthenticatedUser,
  ) {
    await this.networkOrThrow(tenantId, networkId);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const network = await tx.network.update({
          where: {
            id: networkId,
            ...(dto.expectedRevision === undefined
              ? {}
              : { revision: dto.expectedRevision }),
          },
          data: {
            ...(dto.name === undefined ? {} : { name: dto.name }),
            ...(dto.description === undefined
              ? {}
              : { description: dto.description.trim() || null }),
            revision: { increment: 1 },
            updatedBy: actor.id,
          },
        });
        await this.audit(tx, tenantId, actor, {
          action: "network.update",
          resourceType: "Network",
          resourceId: network.id,
          resourceName: network.name,
          changes: dto as Prisma.InputJsonValue,
        });
        return network;
      });
    } catch (error) {
      this.rethrowRevisionConflict(
        error,
        dto.expectedRevision,
        "Network changed since it was loaded",
      );
      this.rethrowKnownConflict(error, "A Network with this name already exists");
      throw error;
    }
  }

  async deleteNetwork(
    tenantId: string,
    networkId: string,
    actor: AuthenticatedUser,
  ) {
    const network = await this.prisma.network.findFirst({
      where: { id: networkId, tenantId },
      include: {
        _count: {
          select: { attachments: true, remoteLanAttachments: true, deviceVpnAccess: true },
        },
      },
    });
    if (!network) throw new NotFoundException("Network not found");
    if (
      network._count.attachments > 0 ||
      network._count.remoteLanAttachments > 0 ||
      network._count.deviceVpnAccess > 0
    ) {
      throw new ConflictException(
        "Detach all applications, Site VPN instances and Device VPN access before deleting this Network",
      );
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const deleting = await tx.network.update({
        where: { id: networkId },
        data: {
          status: "Deleting",
          revision: { increment: 1 },
          updatedBy: actor.id,
          lastError: null,
        },
      });
      await this.audit(tx, tenantId, actor, {
        action: "network.delete.requested",
        resourceType: "Network",
        resourceId: network.id,
        resourceName: network.name,
        changes: { cidr: network.cidr, overlayCidr: network.overlayCidr },
      });
      return deleting;
    });
    return { deleting: true, network: updated };
  }

  async attachApplication(
    tenantId: string,
    networkId: string,
    dto: AttachNetworkDto,
    actor: AuthenticatedUser,
  ) {
    const [network, singleApp] = await Promise.all([
      this.networkOrThrow(tenantId, networkId),
      this.prisma.singleApp.findFirst({
        where: {
          id: dto.singleAppId,
          pendingDeletion: false,
          appGroup: { tenantId },
        },
        select: {
          id: true,
          name: true,
          appGroupId: true,
          appGroup: { select: { name: true } },
        },
      }),
    ]);
    if (!singleApp) throw new NotFoundException("Application not found");

    const parsed = parseIpv4Cidr(network.cidr);
    if (!parsed) throw new ConflictException("Network has invalid address space");
    const used = await this.prisma.networkAttachment.findMany({
      where: { networkId },
      select: { address: true },
    });
    const address = dto.address?.trim() || nextAvailableApplicationAddress(
      parsed,
      used.map((item) => item.address),
    );
    if (!address) {
      throw new ConflictException("Network address space is exhausted");
    }
    this.assertApplicationAddress(parsed, address);

    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.bumpNetworkRevision(
          tx,
          networkId,
          dto.expectedRevision,
          actor.id,
        );
        const attachment = await tx.networkAttachment.create({
          data: {
            networkId,
            singleAppId: singleApp.id,
            address,
            createdBy: actor.id,
          },
        });
        await this.markAppGroupDraftChanged(tx, singleApp.appGroupId, actor.id);
        await this.audit(tx, tenantId, actor, {
          action: "network.application.attach",
          resourceType: "NetworkAttachment",
          resourceId: attachment.id,
          resourceName: `${network.name} / ${singleApp.appGroup.name} / ${singleApp.name}`,
          changes: {
            networkId,
            singleAppId: singleApp.id,
            address,
            deploymentRequired: true,
          },
        });
        return { ...attachment, deploymentRequired: true };
      });
    } catch (error) {
      this.rethrowRevisionConflict(
        error,
        dto.expectedRevision,
        "Network topology changed since it was loaded",
      );
      this.rethrowKnownConflict(
        error,
        "This application is already attached or the requested Network address is in use",
      );
      throw error;
    }
  }

  async detachApplication(
    tenantId: string,
    networkId: string,
    attachmentId: string,
    actor: AuthenticatedUser,
    expectedRevision?: number,
  ) {
    const attachment = await this.prisma.networkAttachment.findFirst({
      where: {
        id: attachmentId,
        networkId,
        network: { tenantId },
      },
      include: {
        network: { select: { name: true } },
        singleApp: {
          select: {
            name: true,
            appGroupId: true,
            appGroup: { select: { name: true } },
          },
        },
      },
    });
    if (!attachment) throw new NotFoundException("Network attachment not found");
    await this.prisma.$transaction(async (tx) => {
      await this.bumpNetworkRevision(
        tx,
        networkId,
        expectedRevision,
        actor.id,
      );
      await tx.networkAttachment.delete({ where: { id: attachment.id } });
      await this.markAppGroupDraftChanged(
        tx,
        attachment.singleApp.appGroupId,
        actor.id,
      );
      await this.audit(tx, tenantId, actor, {
        action: "network.application.detach",
        resourceType: "NetworkAttachment",
        resourceId: attachment.id,
        resourceName: `${attachment.network.name} / ${attachment.singleApp.appGroup.name} / ${attachment.singleApp.name}`,
        changes: {
          networkId,
          singleAppId: attachment.singleAppId,
          address: attachment.address,
          deploymentRequired: true,
        },
      });
    });
    return { deleted: true, deploymentRequired: true };
  }

  async listGates(tenantId: string) {
    const gates = await this.prisma.resourcePortalGate.findMany({
      where: { tenantId, revokedAt: null },
      orderBy: { name: "asc" },
    });
    return gates.map((gate) => this.publicGate(gate));
  }

  async createGate(
    tenantId: string,
    dto: CreateGateDto,
    actor: AuthenticatedUser,
  ) {
    await this.ensureTenantExists(tenantId);
    const [gates, keyPair] = await Promise.all([
      this.prisma.resourcePortalGate.findMany({
        select: {
          serverListenPort: true,
          serverTunnelAddress: true,
          clientTunnelAddress: true,
        },
      }),
      Promise.resolve(this.wireGuard.generateKeyPair()),
    ]);
    const listenPort = this.nextGatePort(
      gates.map((gate) => gate.serverListenPort).filter((v): v is number => v !== null),
    );
    const tunnel = nextAvailableGateTunnel(
      gates.flatMap((gate) =>
        [gate.serverTunnelAddress, gate.clientTunnelAddress].filter(
          (value): value is string => Boolean(value),
        ),
      ),
      this.gateTunnelPool(),
    );
    if (listenPort === null || !tunnel) {
      throw new ConflictException("No free ResourcePortalGate endpoint is available");
    }
    const id = randomUUID();
    const enrollment = this.newEnrollment();

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const gate = await tx.resourcePortalGate.create({
          data: {
            id,
            tenantId,
            name: dto.name,
            description: dto.description?.trim() || null,
            status: "PendingEnrollment",
            serverPublicKey: keyPair.publicKey,
            serverPrivateKeyCiphertext: this.encryption.encrypt(keyPair.privateKey),
            serverListenPort: listenPort,
            serverTunnelAddress: tunnel.server,
            clientTunnelAddress: tunnel.client,
            createdBy: actor.id,
            updatedBy: actor.id,
          },
        });
        await tx.resourcePortalGateEnrollment.create({
          data: {
            gateId: gate.id,
            tokenHash: hashToken(enrollment.token),
            expiresAt: enrollment.expiresAt,
            createdBy: actor.id,
          },
        });
        await this.audit(tx, tenantId, actor, {
          action: "gate.create",
          resourceType: "ResourcePortalGate",
          resourceId: gate.id,
          resourceName: gate.name,
          changes: {
            serverListenPort: listenPort,
            serverTunnelAddress: tunnel.server,
          },
        });
        return gate;
      });
      return {
        gate: this.publicGate(created),
        enrollment,
        endpointHost: this.endpointHost(),
      };
    } catch (error) {
      this.rethrowKnownConflict(error, "ResourcePortalGate name or endpoint is already in use");
      throw error;
    }
  }

  async createGateEnrollment(
    tenantId: string,
    gateId: string,
    actor: AuthenticatedUser,
  ) {
    const gate = await this.gateOrThrow(tenantId, gateId);
    if (gate.revokedAt) throw new ConflictException("ResourcePortalGate is revoked");
    const enrollment = this.newEnrollment();
    await this.prisma.$transaction(async (tx) => {
      await tx.resourcePortalGateEnrollment.updateMany({
        where: { gateId, usedAt: null },
        data: { usedAt: new Date() },
      });
      await tx.resourcePortalGateEnrollment.create({
        data: {
          gateId,
          tokenHash: hashToken(enrollment.token),
          expiresAt: enrollment.expiresAt,
          createdBy: actor.id,
        },
      });
      await tx.resourcePortalGate.update({
        where: { id: gateId },
        data: {
          status: "PendingEnrollment",
          publicKey: null,
          agentTokenHash: null,
          agentVersion: null,
          lastSeenAt: null,
          lastError: null,
          configRevision: { increment: 1 },
          updatedBy: actor.id,
        },
      });
      await this.audit(tx, tenantId, actor, {
        action: "gate.enrollment.rotate",
        resourceType: "ResourcePortalGate",
        resourceId: gate.id,
        resourceName: gate.name,
        changes: { expiresAt: enrollment.expiresAt.toISOString() },
      });
    });
    return {
      gateId,
      enrollment,
      endpointHost: this.endpointHost(),
    };
  }

  async revokeGate(
    tenantId: string,
    gateId: string,
    actor: AuthenticatedUser,
  ) {
    const gate = await this.gateOrThrow(tenantId, gateId);
    if (gate.revokedAt) return this.publicGate(gate);
    const revokedAt = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      const value = await tx.resourcePortalGate.update({
        where: { id: gateId },
        data: {
          status: "Deleting",
          revokedAt,
          agentTokenHash: null,
          configRevision: { increment: 1 },
          updatedBy: actor.id,
        },
      });
      await tx.resourcePortalGateEnrollment.updateMany({
        where: { gateId, usedAt: null },
        data: { usedAt: revokedAt },
      });
      await this.audit(tx, tenantId, actor, {
        action: "gate.delete.requested",
        resourceType: "ResourcePortalGate",
        resourceId: gate.id,
        resourceName: gate.name,
        changes: {
          revokedAt: revokedAt.toISOString(),
          cleanupRequired: true,
        },
      });
      return value;
    });
    return this.publicGate(updated);
  }

  async listDeviceVpnDevices(
    tenantId: string,
    actor: AuthenticatedUser,
  ) {
    await this.ensureTenantExists(tenantId);
    const devices = await this.prisma.deviceVpnDevice.findMany({
      where: { tenantId, userId: actor.id, revokedAt: null },
      orderBy: { createdAt: "asc" },
      include: {
        networks: {
          orderBy: { createdAt: "asc" },
          include: { network: true },
        },
      },
    });
    return devices.map((device) => this.publicDeviceVpnDevice(device));
  }

  async createDeviceVpnDevice(
    tenantId: string,
    dto: CreateDeviceVpnDeviceDto,
    actor: AuthenticatedUser,
  ) {
    await this.ensureTenantExists(tenantId);
    const name = dto.name.trim();
    if (!name) throw new BadRequestException("Device name is required");

    const networkIds = [...new Set(dto.networkIds)].sort();
    const networks = await this.prisma.network.findMany({
      where: {
        tenantId,
        id: { in: networkIds },
        status: { not: "Deleting" },
      },
      orderBy: { name: "asc" },
    });
    if (networks.length !== networkIds.length) {
      throw new BadRequestException(
        "Every Device VPN Network must exist in this tenant and not be deleting",
      );
    }

    const [gateway, usedDevices, clientKeyPair] = await Promise.all([
      this.ensureDeviceVpnGateway(),
      this.prisma.deviceVpnDevice.findMany({
        select: { assignedAddress: true },
      }),
      Promise.resolve(this.wireGuard.generateKeyPair()),
    ]);
    const assignedAddress = nextAvailableDeviceVpnAddress(
      usedDevices.map((device) => device.assignedAddress),
      this.deviceVpnPool(),
    );
    if (!assignedAddress) {
      throw new ConflictException("No free Device VPN address is available");
    }

    try {
      const device = await this.prisma.$transaction(async (tx) => {
        const created = await tx.deviceVpnDevice.create({
          data: {
            tenantId,
            userId: actor.id,
            name,
            publicKey: clientKeyPair.publicKey,
            assignedAddress,
            status: "Pending",
            createdBy: actor.id,
            updatedBy: actor.id,
            networks: {
              create: networkIds.map((networkId) => ({
                networkId,
                createdBy: actor.id,
              })),
            },
          },
          include: {
            networks: {
              orderBy: { createdAt: "asc" },
              include: { network: true },
            },
          },
        });
        await this.audit(tx, tenantId, actor, {
          action: "device_vpn.device.create",
          resourceType: "DeviceVpnDevice",
          resourceId: created.id,
          resourceName: created.name,
          changes: {
            assignedAddress,
            networkIds,
            privateKeyStored: false,
          },
        });
        return created;
      });
      return {
        device: this.publicDeviceVpnDevice(device),
        configuration: this.deviceVpnConfiguration(
          gateway,
          device,
          networks,
          clientKeyPair.privateKey,
        ),
      };
    } catch (error) {
      this.rethrowKnownConflict(
        error,
        "A Device VPN with this name, public key or address already exists",
      );
      throw error;
    }
  }

  async updateDeviceVpnDevice(
    tenantId: string,
    deviceId: string,
    dto: UpdateDeviceVpnDeviceDto,
    actor: AuthenticatedUser,
  ) {
    const existing = await this.deviceVpnDeviceOrThrow(
      tenantId,
      deviceId,
      actor.id,
    );
    if (existing.revokedAt) {
      throw new ConflictException("Device VPN is revoked");
    }

    const name = dto.name === undefined ? existing.name : dto.name.trim();
    if (!name) throw new BadRequestException("Device name is required");
    const networkIds =
      dto.networkIds === undefined
        ? existing.networks.map((link) => link.networkId).sort()
        : [...new Set(dto.networkIds)].sort();
    if (networkIds.length === 0) {
      throw new BadRequestException("Device VPN requires at least one Network");
    }
    const networks = await this.prisma.network.findMany({
      where: {
        tenantId,
        id: { in: networkIds },
        status: { not: "Deleting" },
      },
      orderBy: { name: "asc" },
    });
    if (networks.length !== networkIds.length) {
      throw new BadRequestException(
        "Every Device VPN Network must exist in this tenant and not be deleting",
      );
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.deviceVpnNetworkAccess.deleteMany({ where: { deviceId } });
        await tx.deviceVpnNetworkAccess.createMany({
          data: networkIds.map((networkId) => ({
            deviceId,
            networkId,
            createdBy: actor.id,
          })),
        });
        await tx.deviceVpnDevice.update({
          where: { id: deviceId },
          data: {
            name,
            status: "Pending",
            lastError: null,
            configRevision: { increment: 1 },
            updatedBy: actor.id,
          },
        });
        await this.audit(tx, tenantId, actor, {
          action: "device_vpn.device.update",
          resourceType: "DeviceVpnDevice",
          resourceId: deviceId,
          resourceName: name,
          changes: { networkIds },
        });
      });
    } catch (error) {
      this.rethrowKnownConflict(
        error,
        "A Device VPN with this name already exists for this user",
      );
      throw error;
    }

    const updated = await this.deviceVpnDeviceOrThrow(
      tenantId,
      deviceId,
      actor.id,
    );
    return this.publicDeviceVpnDevice(updated);
  }

  async revokeDeviceVpnDevice(
    tenantId: string,
    deviceId: string,
    actor: AuthenticatedUser,
  ) {
    const existing = await this.deviceVpnDeviceOrThrow(
      tenantId,
      deviceId,
      actor.id,
    );
    if (existing.revokedAt) return this.publicDeviceVpnDevice(existing);

    const revokedAt = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      const device = await tx.deviceVpnDevice.update({
        where: { id: deviceId },
        data: {
          status: "Revoked",
          revokedAt,
          lastError: null,
          configRevision: { increment: 1 },
          updatedBy: actor.id,
        },
        include: {
          networks: {
            orderBy: { createdAt: "asc" },
            include: { network: true },
          },
        },
      });
      await this.audit(tx, tenantId, actor, {
        action: "device_vpn.device.revoke",
        resourceType: "DeviceVpnDevice",
        resourceId: device.id,
        resourceName: device.name,
        changes: { revokedAt: revokedAt.toISOString() },
      });
      return device;
    });
    return this.publicDeviceVpnDevice(updated);
  }

  async deviceVpnRuntimeHeartbeat(
    authorization: string | undefined,
    dto: DeviceVpnRuntimeHeartbeatDto,
  ) {
    const token = bearerToken(authorization);
    if (!token) {
      throw new UnauthorizedException("Device VPN runtime bearer token is required");
    }
    const gateway = await this.prisma.deviceVpnGateway.findUnique({
      where: { runtimeTokenHash: hashToken(token) },
    });
    if (!gateway) {
      throw new UnauthorizedException("Invalid Device VPN runtime token");
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.deviceVpnGateway.update({
        where: { id: gateway.id },
        data: { lastSeenAt: now, status: "Ready", lastError: null },
      });
      for (const peer of dto.peers) {
        if (
          !this.wireGuard.isPublicKey(peer.publicKey) ||
          peer.latestHandshake <= 0
        ) {
          continue;
        }
        const handshake = new Date(peer.latestHandshake * 1000);
        if (
          !Number.isFinite(handshake.getTime()) ||
          handshake.getTime() > now.getTime() + 60_000
        ) {
          continue;
        }
        await tx.deviceVpnDevice.updateMany({
          where: {
            publicKey: peer.publicKey,
            revokedAt: null,
            OR: [
              { lastSeenAt: null },
              { lastSeenAt: { lt: handshake } },
            ],
          },
          data: { lastSeenAt: handshake },
        });
      }
    });
    return { ok: true };
  }

  async enrollGate(dto: GateEnrollDto) {
    const enrollment = await this.prisma.resourcePortalGateEnrollment.findUnique({
      where: { tokenHash: hashToken(dto.token) },
      include: { gate: true },
    });
    if (
      !enrollment ||
      enrollment.usedAt ||
      enrollment.expiresAt.getTime() <= Date.now() ||
      enrollment.gate.revokedAt
    ) {
      throw new UnauthorizedException("Invalid or expired ResourcePortalGate enrollment token");
    }
    if (!this.wireGuard.isPublicKey(dto.publicKey)) {
      throw new BadRequestException("Invalid WireGuard public key");
    }
    if (!["gate-l2-v1","gate-l2-v2"].includes(dto.agentVersion))
      throw new BadRequestException("Only certified RP Gate LAN Attachment agents can enroll");

    const agentToken = randomBytes(32).toString("base64url");
    const now = new Date();
    const gate = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.resourcePortalGateEnrollment.updateMany({
        where: { id: enrollment.id, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (claimed.count !== 1) {
        throw new UnauthorizedException("ResourcePortalGate enrollment token was already used or expired");
      }
      return tx.resourcePortalGate.update({
        where: { id: enrollment.gateId },
        data: {
          publicKey: dto.publicKey,
          agentTokenHash: hashToken(agentToken),
          agentVersion: dto.agentVersion,
          lastSeenAt: now,
          status: "Ready",
          lastError: null,
          configRevision: { increment: 1 },
        },
        include: {
          remoteLanAttachments: true,
        },
      });
    });

    return {
      agentToken,
      ...this.agentConfig(gate),
    };
  }

  async gateHeartbeat(authorization: string | undefined, dto: GateHeartbeatDto) {
    const gate = await this.authenticateGateAgent(authorization, true);
    if (!["gate-l2-v1","gate-l2-v2"].includes(dto.agentVersion))
      throw new BadRequestException("RP Gate must use a certified LAN Attachment protocol");
    if (dto.agentVersion === "gate-l2-v1" && dto.lanObservation)
      throw new BadRequestException("Legacy Gate may not advertise managed LAN");
    let observedLan: Prisma.InputJsonValue | typeof Prisma.DbNull = Prisma.DbNull;
    if (dto.lanObservation) {
      try {
        const segment = verifiedManagedLan(gate.id,dto.lanObservation.physicalInterface,
          dto.lanObservation,new Date(dto.lanObservation.observedAt));
        observedLan = segment;
      } catch (error) {
        throw new BadRequestException("Invalid authenticated Gate LAN observation: "+String(error));
      }
    }
    const updated = await this.prisma.resourcePortalGate.update({
      where: { id: gate.id },
      data: {
        agentVersion: dto.agentVersion,
        observedLan, observedLanAt: dto.lanObservation ? new Date() : null,
        lastSeenAt: new Date(),
      },
      include: { remoteLanAttachments: true },
    });
    return this.agentConfig(updated);
  }

  async gateAgentConfig(authorization: string | undefined) {
    const gate = await this.authenticateGateAgent(authorization, false);
    if (!["gate-l2-v1","gate-l2-v2"].includes(gate.agentVersion ?? ""))
      throw new UnauthorizedException("Legacy RP Gate agent must be upgraded");
    const full = await this.prisma.resourcePortalGate.findUniqueOrThrow({
      where: { id: gate.id },
      include: { remoteLanAttachments: true },
    });
    return this.agentConfig(full);
  }

  private agentConfig(gate: {
    id: string;
    tenantId: string;
    remoteLanAttachments?: Array<{
      id: string; tenantId: string; gateId: string; singleAppId: string; networkId: string;
      lanInterface: string; lanCidr: string; macAddress: string; status: string;
      uplinkMode: string; addressMode: string; configurationRevision: number;
      staticAddress: string | null; staticGateway: string | null;
    }>;
    serverPublicKey: string | null;
    serverListenPort: number | null;
    clientTunnelAddress: string | null;
    serverTunnelAddress: string | null;
    configRevision: number;
    revokedAt: Date | null;
  }) {
    if (!gate.serverPublicKey || !gate.serverListenPort ||
        !gate.clientTunnelAddress || !gate.serverTunnelAddress)
      throw new ConflictException("RP Gate L2 underlay is not enrolled");
    const grants = (gate.remoteLanAttachments ?? [])
      .filter(item => item.tenantId === gate.tenantId && item.gateId === gate.id &&
        ["Provisioning","Active"].includes(item.status))
      .map(item => ({
        id: item.id, singleAppId: item.singleAppId,
        networkId: item.networkId, lanInterface: item.lanInterface,
        lanCidr: item.lanCidr, macAddress: item.macAddress,
        uplinkMode: item.uplinkMode, addressMode: item.addressMode,
        configurationRevision: item.configurationRevision,
        staticAddress: item.staticAddress, staticGateway: item.staticGateway,
      }))
      .sort((x,y) => x.id.localeCompare(y.id));
    return {
      gateId: gate.id, tenantId: gate.tenantId,
      lanAttachmentProtocol: 1,
      lanAttachments: grants,
      endpoint: this.endpointHost() + ":" + gate.serverListenPort,
      serverPublicKey: gate.serverPublicKey,
      tunnelAddress: gate.clientTunnelAddress,
      serverTunnelAddress: gate.serverTunnelAddress,
      // WireGuard transports only its peer's /32. LAN frames are bridged
      // over per-attachment GRETAP; no Site-level CIDRs or BGP routes.
      allowedIps: grants.length ?
        [gate.serverTunnelAddress.split("/")[0] + "/32"] : [],
      configRevision: gate.configRevision,
      revoked: Boolean(gate.revokedAt),
      persistentKeepaliveSeconds: 25,
    };
  }

  private async authenticateGateAgent(
    authorization: string | undefined,
    updateSeen: boolean,
  ) {
    const token = bearerToken(authorization);
    if (!token) throw new UnauthorizedException("ResourcePortalGate bearer token is required");
    const gate = await this.prisma.resourcePortalGate.findUnique({
      where: { agentTokenHash: hashToken(token) },
    });
    if (!gate || gate.revokedAt) {
      throw new UnauthorizedException("Invalid or revoked ResourcePortalGate token");
    }
    if (updateSeen) {
      await this.prisma.resourcePortalGate.update({
        where: { id: gate.id },
        data: { lastSeenAt: new Date() },
      });
    }
    return gate;
  }

  private async ensureDeviceVpnGateway() {
    const existing = await this.prisma.deviceVpnGateway.findUnique({
      where: { id: "primary" },
    });
    if (existing) return existing;

    const keyPair = this.wireGuard.generateKeyPair();
    const runtimeToken = randomBytes(32).toString("base64url");
    try {
      return await this.prisma.deviceVpnGateway.create({
        data: {
          id: "primary",
          publicKey: keyPair.publicKey,
          privateKeyCiphertext: this.encryption.encrypt(keyPair.privateKey),
          runtimeTokenHash: hashToken(runtimeToken),
          runtimeTokenCiphertext: this.encryption.encrypt(runtimeToken),
          listenPort: this.deviceVpnPort(),
          serverTunnelAddress: this.deviceVpnServerAddress(),
          status: "Provisioning",
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return this.prisma.deviceVpnGateway.findUniqueOrThrow({
          where: { id: "primary" },
        });
      }
      throw error;
    }
  }

  private deviceVpnConfiguration(
    gateway: {
      publicKey: string;
      listenPort: number;
    },
    device: {
      assignedAddress: string;
    },
    networks: Array<{ cidr: string }>,
    privateKey: string,
  ) {
    const allowedIps = networks.map((network) => network.cidr).sort();
    const endpoint = `${this.deviceVpnEndpointHost()}:${gateway.listenPort}`;
    const address = `${device.assignedAddress}/32`;
    const wireguardConfig = [
      "[Interface]",
      `PrivateKey = ${privateKey}`,
      `Address = ${address}`,
      "",
      "[Peer]",
      `PublicKey = ${gateway.publicKey}`,
      `Endpoint = ${endpoint}`,
      `AllowedIPs = ${allowedIps.join(", ")}`,
      "PersistentKeepalive = 25",
      "",
    ].join("\n");
    return {
      endpoint,
      serverPublicKey: gateway.publicKey,
      address,
      allowedIps,
      persistentKeepaliveSeconds: 25,
      privateKey,
      wireguardConfig,
      privateKeyStored: false,
    };
  }

  private publicDeviceVpnDevice(
    device: Record<string, unknown> & {
      networks?: Array<{
        networkId: string;
        network?: {
          id: string;
          name: string;
          cidr: string;
        };
      }>;
    },
  ) {
    const safe: Record<string, unknown> = { ...device };
    safe.address =
      typeof device.assignedAddress === "string"
        ? `${device.assignedAddress}/32`
        : device.assignedAddress;
    safe.networks = (device.networks ?? [])
      .flatMap((link) =>
        link.network
          ? [
              {
                id: link.network.id,
                name: link.network.name,
                cidr: link.network.cidr,
              },
            ]
          : [],
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    return safe;
  }

  private deviceVpnDeviceOrThrow(
    tenantId: string,
    deviceId: string,
    userId: string,
  ) {
    return this.prisma.deviceVpnDevice
      .findFirst({
        where: { id: deviceId, tenantId, userId },
        include: {
          networks: {
            orderBy: { createdAt: "asc" },
            include: { network: true },
          },
        },
      })
      .then((device) => {
        if (!device) throw new NotFoundException("Device VPN not found");
        return device;
      });
  }

  private deviceVpnEndpointHost() {
    const value =
      this.config.get<string>("RESOURCEPORTAL_DEVICE_VPN_ENDPOINT_HOST") ??
      this.config.get<string>("RESOURCEPORTAL_GATE_ENDPOINT_HOST") ??
      this.config.get<string>("RESOURCEPORTAL_PUBLIC_HOSTNAME");
    if (!value) {
      throw new ConflictException("Device VPN endpoint host is not configured");
    }
    return value.replace(/^https?:\/\//, "").replace(/\/$/, "");
  }

  private deviceVpnPool() {
    return (
      this.config.get<string>("RESOURCEPORTAL_DEVICE_VPN_POOL") ??
      DEFAULT_DEVICE_VPN_POOL
    );
  }

  private deviceVpnPort() {
    const value = Number.parseInt(
      this.config.get<string>("RESOURCEPORTAL_DEVICE_VPN_PORT", "51820"),
      10,
    );
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      throw new ConflictException("Device VPN UDP port is invalid");
    }
    if (value >= GATE_PORT_MIN && value <= GATE_PORT_MAX) {
      throw new ConflictException(
        "Device VPN UDP port must not overlap the Site VPN Gate port range",
      );
    }
    return value;
  }

  private deviceVpnServerAddress() {
    const configured = this.config.get<string>(
      "RESOURCEPORTAL_DEVICE_VPN_SERVER_ADDRESS",
    );
    if (configured) {
      const parsed = parseIpv4Cidr(configured);
      const pool = parseIpv4Cidr(this.deviceVpnPool());
      const address = configured.split("/")[0]?.trim();
      if (
        !parsed ||
        !pool ||
        !address ||
        !containsIpv4(pool, address) ||
        parsed.prefix !== pool.prefix ||
        parsed.network !== pool.network
      ) {
        throw new ConflictException(
          "Device VPN server address must be a usable host in the configured Device VPN pool using the pool prefix",
        );
      }
      if (address === intToIpv4(pool.network) || address === intToIpv4(pool.broadcast)) {
        throw new ConflictException("Device VPN server address is not usable");
      }
      return `${address}/${pool.prefix}`;
    }
    const pool = parseIpv4Cidr(this.deviceVpnPool());
    if (!pool || pool.prefix > 30) {
      throw new ConflictException("Device VPN address pool is invalid");
    }
    return `${intToIpv4(pool.network + 1)}/${pool.prefix}`;
  }

  private resolveNetworkCidr(
    requested: string | undefined,
    existing: Array<{ cidr: string; overlayCidr: string }>,
  ) {
    if (!requested) {
      const allocated = nextAvailableNetworkCidr(
        existing.flatMap((network) => [network.cidr, network.overlayCidr]),
        this.networkPool(),
        DEFAULT_NETWORK_PREFIX,
      );
      if (!allocated) throw new ConflictException("No free Network CIDR is available");
      return allocated;
    }
    const parsed = parseIpv4Cidr(requested);
    if (
      !parsed ||
      !isPrivateIpv4Cidr(parsed) ||
      parsed.prefix < 16 ||
      parsed.prefix > 28
    ) {
      throw new BadRequestException(
        "cidr must be a private IPv4 network with prefix /16 through /28",
      );
    }
    const overlayPool = parseIpv4Cidr(this.overlayPool());
    const gatePool = parseIpv4Cidr(this.gateTunnelPool());
    if (
      (overlayPool && cidrsOverlap(parsed, overlayPool)) ||
      (gatePool && cidrsOverlap(parsed, gatePool))
    ) {
      throw new ConflictException(
        "Network CIDR overlaps a ResourcePortal reserved networking pool",
      );
    }
    const allExisting = existing
      .flatMap((network) => [network.cidr, network.overlayCidr])
      .map(parseIpv4Cidr)
      .filter((value): value is NonNullable<typeof value> => Boolean(value));
    if (allExisting.some((item) => cidrsOverlap(parsed, item))) {
      throw new ConflictException("Network CIDR overlaps an existing ResourcePortal network");
    }
    return parsed.normalized;
  }

  private assertApplicationAddress(cidr: NonNullable<ReturnType<typeof parseIpv4Cidr>>, address: string) {
    if (!containsIpv4(cidr, address)) {
      throw new BadRequestException("Application address must belong to the Network CIDR");
    }
    const firstAllowed = cidr.network + 10;
    const parsedHost = parseIpv4Cidr(`${address}/32`);
    if (
      !parsedHost ||
      parsedHost.network < firstAllowed ||
      parsedHost.network >= cidr.broadcast
    ) {
      throw new BadRequestException(
        "Application address is reserved or not usable in this Network",
      );
    }
  }

  private nextGatePort(used: number[]) {
    const occupied = new Set(used);
    for (let port = GATE_PORT_MIN; port <= GATE_PORT_MAX; port += 1) {
      if (!occupied.has(port)) return port;
    }
    return null;
  }

  private newEnrollment() {
    return {
      token: randomBytes(32).toString("base64url"),
      expiresAt: new Date(Date.now() + ENROLLMENT_TTL_MS),
    };
  }

  private endpointHost() {
    const value =
      this.config.get<string>("RESOURCEPORTAL_GATE_ENDPOINT_HOST") ??
      this.config.get<string>("RESOURCEPORTAL_PUBLIC_HOSTNAME");
    if (!value) {
      throw new ConflictException("ResourcePortalGate endpoint host is not configured");
    }
    return value.replace(/^https?:\/\//, "").replace(/\/$/, "");
  }

  private networkPool() {
    return (
      this.config.get<string>("RESOURCEPORTAL_NETWORK_POOL") ??
      DEFAULT_NETWORK_POOL
    );
  }

  private overlayPool() {
    return (
      this.config.get<string>("RESOURCEPORTAL_NETWORK_OVERLAY_POOL") ??
      DEFAULT_OVERLAY_POOL
    );
  }

  private gateTunnelPool() {
    return (
      this.config.get<string>("RESOURCEPORTAL_GATE_TUNNEL_POOL") ??
      DEFAULT_GATE_TUNNEL_POOL
    );
  }

  private async networkOrThrow(tenantId: string, networkId: string) {
    const network = await this.prisma.network.findFirst({
      where: { id: networkId, tenantId },
    });
    if (!network) throw new NotFoundException("Network not found");
    if (network.status === "Deleting") {
      throw new ConflictException("Network is being deleted");
    }
    return network;
  }

  private gateOrThrow(tenantId: string, gateId: string) {
    return this.prisma.resourcePortalGate.findFirst({
      where: { id: gateId, tenantId },
    }).then((gate) => {
      if (!gate) throw new NotFoundException("ResourcePortalGate not found");
      return gate;
    });
  }

  private async ensureTenantExists(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });
    if (!tenant) throw new NotFoundException("Tenant not found");
  }

  private async bumpNetworkRevision(
    tx: Prisma.TransactionClient,
    networkId: string,
    expectedRevision: number | undefined,
    actorId: string,
  ) {
    try {
      return await tx.network.update({
        where: {
          id: networkId,
          ...(expectedRevision === undefined
            ? {}
            : { revision: expectedRevision }),
        },
        data: {
          revision: { increment: 1 },
          updatedBy: actorId,
        },
      });
    } catch (error) {
      this.rethrowRevisionConflict(
        error,
        expectedRevision,
        "Network topology changed since it was loaded",
      );
      throw error;
    }
  }

  private async bumpGateRevision(
    tx: Prisma.TransactionClient,
    gateId: string,
    expectedRevision: number | undefined,
    actorId: string,
  ) {
    try {
      return await tx.resourcePortalGate.update({
        where: {
          id: gateId,
          ...(expectedRevision === undefined
            ? {}
            : { configRevision: expectedRevision }),
        },
        data: {
          configRevision: { increment: 1 },
          updatedBy: actorId,
        },
      });
    } catch (error) {
      this.rethrowRevisionConflict(
        error,
        expectedRevision,
        "ResourcePortalGate topology changed since it was loaded",
      );
      throw error;
    }
  }

  private markAppGroupDraftChanged(
    tx: Prisma.TransactionClient,
    appGroupId: string,
    actorId: string,
  ) {
    return tx.appGroup.update({
      where: { id: appGroupId },
      data: {
        hasPendingChanges: true,
        runtimeDraftRevision: { increment: 1 },
        updatedBy: actorId,
      },
    });
  }

  private async audit(
    tx: Prisma.TransactionClient,
    tenantId: string,
    actor: AuthenticatedUser,
    input: {
      action: string;
      resourceType: string;
      resourceId: string;
      resourceName: string;
      changes: Prisma.InputJsonValue;
    },
  ) {
    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true },
    });
    return tx.auditLogEntry.create({
      data: {
        tenantId,
        tenantName: tenant?.name ?? "Tenant",
        actor: actor.id,
        actorName: actor.displayName,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        resourceName: input.resourceName,
        result: "Success",
        correlationId: randomUUID(),
        changes: input.changes,
      },
    });
  }

  private publicGate(gate: {
    id?: string; tenantId?: string; name?: string; description?: string | null;
    status?: string; agentVersion?: string | null; serverListenPort?: number | null;
    lastSeenAt?: Date | null; lastError?: string | null; revokedAt?: Date | null;
    configRevision?: number;
    observedLan?: Prisma.JsonValue;
    observedLanAt?: Date | null;
  }) {
    // Explicit allow-list prevents old Site VPN policy columns from leaking
    // back into the active tenant API during migration.
    return {
      id: gate.id, tenantId: gate.tenantId, name: gate.name,
      description: gate.description, status: gate.status,
      agentVersion: gate.agentVersion,
      serverListenPort: gate.serverListenPort,
      lastSeenAt: gate.lastSeenAt, lastError: gate.lastError,
      revokedAt: gate.revokedAt, configRevision: gate.configRevision,
      observedLan: gate.observedLan && gate.observedLanAt &&
        Math.abs(Date.now()-gate.observedLanAt.getTime()) <= 60_000
        ? gate.observedLan : null,
      observedLanAt: gate.observedLanAt,
    };
  }

  private rethrowRevisionConflict(
    error: unknown,
    expectedRevision: number | undefined,
    message: string,
  ): never | void {
    if (
      expectedRevision !== undefined &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      throw new ConflictException(message);
    }
  }

  private rethrowKnownConflict(error: unknown, message: string): never | void {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new ConflictException(message);
    }
  }
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function bearerToken(authorization: string | undefined) {
  if (!authorization) return undefined;
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}