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
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "../security/encryption.service";
import type { AttachGateNetworkDto } from "./dto/attach-gate-network.dto";
import type { AttachNetworkDto } from "./dto/attach-network.dto";
import type { CreateGateDto } from "./dto/create-gate.dto";
import type { CreateNetworkDto } from "./dto/create-network.dto";
import type { GateEnrollDto } from "./dto/gate-enroll.dto";
import type { GateHeartbeatDto } from "./dto/gate-heartbeat.dto";
import type { UpdateNetworkDto } from "./dto/update-network.dto";
import {
  DEFAULT_GATE_TUNNEL_POOL,
  DEFAULT_NETWORK_POOL,
  DEFAULT_NETWORK_PREFIX,
  DEFAULT_OVERLAY_POOL,
  cidrsOverlap,
  containsIpv4,
  isPrivateIpv4Cidr,
  nextAvailableApplicationAddress,
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
      | { action: "APP_DETACH"; networkId: string; attachmentId: string }
      | { action: "GATE_ATTACH"; gateId: string; networkId: string }
      | { action: "GATE_DETACH"; gateId: string; networkId: string },
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
      case "GATE_ATTACH": {
        const [gate, network, existingAttachment] = await Promise.all([
          this.prisma.resourcePortalGate.findFirst({
            where: { id: input.gateId, tenantId },
            select: { id: true, configRevision: true, revokedAt: true },
          }),
          this.prisma.network.findFirst({
            where: { id: input.networkId, tenantId },
            select: { id: true, revision: true, cidr: true },
          }),
          this.prisma.gateNetworkAttachment.findFirst({
            where: {
              gateId: input.gateId,
              networkId: input.networkId,
              gate: { tenantId },
            },
            select: { id: true, enabled: true, status: true },
          }),
        ]);
        if (!gate) throw new NotFoundException("ResourcePortalGate not found");
        if (!network) throw new NotFoundException("Network not found");
        return {
          gateRevision: gate.configRevision,
          gateRevokedAt: gate.revokedAt,
          networkRevision: network.revision,
          networkCidr: network.cidr,
          existingAttachment,
        };
      }
      case "GATE_DETACH": {
        const [gate, attachment] = await Promise.all([
          this.prisma.resourcePortalGate.findFirst({
            where: { id: input.gateId, tenantId },
            select: { id: true, configRevision: true },
          }),
          this.prisma.gateNetworkAttachment.findFirst({
            where: {
              gateId: input.gateId,
              networkId: input.networkId,
              gate: { tenantId },
            },
            select: { id: true, enabled: true, status: true },
          }),
        ]);
        if (!gate) throw new NotFoundException("ResourcePortalGate not found");
        if (!attachment) throw new NotFoundException("Gate Network attachment not found");
        return {
          gateRevision: gate.configRevision,
          attachment,
        };
      }
    }
  }

  async topology(tenantId: string) {
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
          gateAttachments: {
            where: { enabled: true },
            orderBy: { createdAt: "asc" },
            include: {
              gate: {
                select: {
                  id: true,
                  name: true,
                  status: true,
                  lastSeenAt: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.resourcePortalGate.findMany({
        where: { tenantId },
        orderBy: { name: "asc" },
        include: {
          networks: {
            where: { enabled: true },
            include: {
              network: {
                select: { id: true, name: true, cidr: true },
              },
            },
            orderBy: { createdAt: "asc" },
          },
        },
      }),
      this.prisma.appGroup.findMany({
        where: { tenantId },
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          hasPendingChanges: true,
          singleApps: {
            where: { pendingDeletion: false },
            orderBy: { name: "asc" },
            select: {
              id: true,
              name: true,
              image: true,
              runtimeState: true,
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
      appGroups,
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
        gateAttachments: {
          where: { enabled: true },
          include: {
            gate: {
              select: { id: true, name: true, status: true, lastSeenAt: true },
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
          select: { attachments: true, gateAttachments: true },
        },
      },
    });
    if (!network) throw new NotFoundException("Network not found");
    if (network._count.attachments > 0 || network._count.gateAttachments > 0) {
      throw new ConflictException(
        "Detach all applications and ResourcePortalGate instances before deleting this Network",
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
      where: { tenantId },
      orderBy: { name: "asc" },
      include: {
        networks: {
          where: { enabled: true },
          orderBy: { createdAt: "asc" },
          include: { network: true },
        },
      },
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
          lanAddresses: [],
          lanCidrs: [],
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

  async attachGateNetwork(
    tenantId: string,
    gateId: string,
    dto: AttachGateNetworkDto,
    actor: AuthenticatedUser,
  ) {
    const [gate, network] = await Promise.all([
      this.gateOrThrow(tenantId, gateId),
      this.networkOrThrow(tenantId, dto.networkId),
    ]);
    if (gate.revokedAt) throw new ConflictException("ResourcePortalGate is revoked");
    this.assertNoLanConflict(network.cidr, gate.lanCidrs);

    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.bumpGateRevision(
          tx,
          gateId,
          dto.expectedRevision,
          actor.id,
        );
        const attachment = await tx.gateNetworkAttachment.create({
          data: {
            gateId,
            networkId: network.id,
            status: "Pending",
            createdBy: actor.id,
          },
        });
        await this.audit(tx, tenantId, actor, {
          action: "gate.network.attach",
          resourceType: "GateNetworkAttachment",
          resourceId: attachment.id,
          resourceName: `${gate.name} / ${network.name}`,
          changes: { gateId, networkId: network.id, cidr: network.cidr },
        });
        return attachment;
      });
    } catch (error) {
      this.rethrowRevisionConflict(
        error,
        dto.expectedRevision,
        "ResourcePortalGate topology changed since it was loaded",
      );
      this.rethrowKnownConflict(error, "This Gate is already attached to the Network");
      throw error;
    }
  }

  async detachGateNetwork(
    tenantId: string,
    gateId: string,
    networkId: string,
    actor: AuthenticatedUser,
    expectedRevision?: number,
  ) {
    const attachment = await this.prisma.gateNetworkAttachment.findFirst({
      where: {
        gateId,
        networkId,
        gate: { tenantId },
      },
      include: {
        gate: { select: { name: true } },
        network: { select: { name: true } },
      },
    });
    if (!attachment) throw new NotFoundException("Gate Network attachment not found");
    await this.prisma.$transaction(async (tx) => {
      await this.bumpGateRevision(
        tx,
        gateId,
        expectedRevision,
        actor.id,
      );
      await tx.gateNetworkAttachment.delete({ where: { id: attachment.id } });
      await this.audit(tx, tenantId, actor, {
        action: "gate.network.detach",
        resourceType: "GateNetworkAttachment",
        resourceId: attachment.id,
        resourceName: `${attachment.gate.name} / ${attachment.network.name}`,
        changes: { gateId, networkId },
      });
    });
    return { deleted: true };
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
          status: "Revoked",
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
        action: "gate.revoke",
        resourceType: "ResourcePortalGate",
        resourceId: gate.id,
        resourceName: gate.name,
        changes: { revokedAt: revokedAt.toISOString() },
      });
      return value;
    });
    return this.publicGate(updated);
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
    const lanAddresses = this.normalizeLanAddresses(dto.lanAddresses);
    const lanCidrs = this.normalizeLanCidrs(dto.lanCidrs);
    const networkLinks = await this.prisma.gateNetworkAttachment.findMany({
      where: { gateId: enrollment.gateId, enabled: true },
      include: { network: { select: { cidr: true } } },
    });
    for (const link of networkLinks) {
      this.assertNoLanConflict(link.network.cidr, lanCidrs);
    }

    const agentToken = randomBytes(32).toString("base64url");
    const now = new Date();
    const gate = await this.prisma.$transaction(async (tx) => {
      await tx.resourcePortalGateEnrollment.update({
        where: { id: enrollment.id },
        data: { usedAt: now },
      });
      return tx.resourcePortalGate.update({
        where: { id: enrollment.gateId },
        data: {
          publicKey: dto.publicKey,
          agentTokenHash: hashToken(agentToken),
          lanAddresses,
          lanCidrs,
          agentVersion: dto.agentVersion?.trim() || null,
          lastSeenAt: now,
          status: "Ready",
          lastError: null,
          configRevision: { increment: 1 },
        },
        include: {
          networks: {
            where: { enabled: true },
            include: { network: true },
          },
        },
      });
    });

    return {
      agentToken,
      ...this.agentConfig(gate),
    };
  }

  async gateHeartbeat(
    authorization: string | undefined,
    dto: GateHeartbeatDto,
  ) {
    const gate = await this.authenticateGateAgent(authorization, true);
    const lanAddresses = this.normalizeLanAddresses(dto.lanAddresses);
    const lanCidrs = this.normalizeLanCidrs(dto.lanCidrs);
    const links = await this.prisma.gateNetworkAttachment.findMany({
      where: { gateId: gate.id, enabled: true },
      include: { network: { select: { cidr: true } } },
    });
    for (const link of links) {
      this.assertNoLanConflict(link.network.cidr, lanCidrs);
    }
    const updated = await this.prisma.resourcePortalGate.update({
      where: { id: gate.id },
      data: {
        lanAddresses,
        lanCidrs,
        agentVersion: dto.agentVersion?.trim() || gate.agentVersion,
        lastSeenAt: new Date(),
      },
      include: {
        networks: {
          where: { enabled: true },
          include: { network: true },
        },
      },
    });
    return this.agentConfig(updated);
  }

  async gateAgentConfig(authorization: string | undefined) {
    const gate = await this.authenticateGateAgent(authorization, false);
    const full = await this.prisma.resourcePortalGate.findUniqueOrThrow({
      where: { id: gate.id },
      include: {
        networks: {
          where: { enabled: true },
          include: { network: true },
        },
      },
    });
    return this.agentConfig(full);
  }

  private agentConfig(gate: {
    id: string;
    serverPublicKey: string | null;
    serverListenPort: number | null;
    clientTunnelAddress: string | null;
    configRevision: number;
    revokedAt: Date | null;
    networks: Array<{ network: { id: string; name: string; cidr: string } }>;
  }) {
    if (
      !gate.serverPublicKey ||
      !gate.serverListenPort ||
      !gate.clientTunnelAddress
    ) {
      throw new ConflictException("ResourcePortalGate server endpoint is incomplete");
    }
    return {
      gateId: gate.id,
      endpoint: `${this.endpointHost()}:${gate.serverListenPort}`,
      serverPublicKey: gate.serverPublicKey,
      tunnelAddress: gate.clientTunnelAddress,
      allowedIps: gate.networks.map((link) => link.network.cidr).sort(),
      networks: gate.networks.map((link) => ({
        id: link.network.id,
        name: link.network.name,
        cidr: link.network.cidr,
      })),
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

  private normalizeLanAddresses(values: string[]) {
    return [...new Set(values.map((value) => value.trim()))].filter(Boolean).sort();
  }

  private normalizeLanCidrs(values: string[]) {
    const normalized = values.map((value) => {
      const parsed = parseIpv4Cidr(value);
      if (!parsed) throw new BadRequestException(`Invalid LAN CIDR: ${value}`);
      return parsed.normalized;
    });
    return [...new Set(normalized)].sort();
  }

  private assertNoLanConflict(networkCidr: string, lanCidrs: string[]) {
    const network = parseIpv4Cidr(networkCidr);
    if (!network) throw new ConflictException("Network has invalid CIDR");
    for (const lanCidr of lanCidrs) {
      const lan = parseIpv4Cidr(lanCidr);
      if (lan && cidrsOverlap(network, lan)) {
        throw new ConflictException(
          `Network CIDR ${network.normalized} overlaps Gate LAN route ${lan.normalized}`,
        );
      }
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

  private publicGate(
    gate: Record<string, unknown> & {
      serverPrivateKeyCiphertext?: string | null;
      agentTokenHash?: string | null;
      enrollments?: unknown;
    },
  ) {
    const safe: Record<string, unknown> = { ...gate };
    delete safe.serverPrivateKeyCiphertext;
    delete safe.agentTokenHash;
    delete safe.enrollments;
    return safe;
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
