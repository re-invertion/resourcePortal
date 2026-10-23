import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import type { AuthenticatedUser } from "../auth/types";
import type { CreateRemoteLanAttachmentDto } from "./dto/create-remote-lan-attachment.dto";
import { parseIpv4Cidr } from "./network-addressing";

/**
 * Control-plane desired state only. An attachment must stay Pending until both
 * ends provide authenticated, versioned L2 dataplane proof and a real DHCP lease.
 * In particular, the old Site VPN WireGuard tunnel is NOT an L2 transport.
 */
@Injectable()
export class RemoteLanAttachmentService {
  constructor(private readonly prisma: PrismaService) {}

  list(tenantId: string) {
    return this.prisma.remoteLanAttachment.findMany({
      where: { tenantId },
      orderBy: { createdAt: "asc" },
    });
  }

  async create(tenantId: string, input: CreateRemoteLanAttachmentDto, actor: AuthenticatedUser) {
    const lan = parseIpv4Cidr(input.lanCidr);
    if (!lan || lan.prefix < 16 || lan.prefix > 30)
      throw new BadRequestException("Remote LAN must have a valid IPv4 DHCP subnet (/16–/30)");
    if (["wg0", "rp-gate", "lo", "docker0"].includes(input.lanInterface) ||
        /^veth|^br-|^tun|^tap|^vxlan|^gretap/i.test(input.lanInterface))
      throw new BadRequestException("Remote LAN interface must be a physical Ethernet port or VLAN");
    const [gate, app, networkAttachment, existing] = await Promise.all([
      this.prisma.resourcePortalGate.findFirst({
        where: { id: input.gateId, tenantId, revokedAt: null },
        select: { id: true, agentVersion: true },
      }),
      this.prisma.singleApp.findFirst({
        where: { id: input.singleAppId, pendingDeletion: false, appGroup: { tenantId } },
        select: { id: true, desiredReplicas: true },
      }),
      this.prisma.networkAttachment.findFirst({
        where: { singleAppId: input.singleAppId, networkId: input.networkId,
          network: { tenantId, status: "Ready" } },
        select: { id: true },
      }),
      this.prisma.remoteLanAttachment.findUnique({ where: { singleAppId: input.singleAppId } }),
    ]);
    if (!gate || !app || !networkAttachment) throw new NotFoundException("Gate, application or its tenant Network not found");
    if (existing) throw new ConflictException("Application already has a remote LAN attachment");
    if (app.desiredReplicas !== 1) throw new BadRequestException("Remote LAN requires exactly one application replica");
    // A dedicated unnumbered Ethernet/VLAN handoff has no host IP and thus
    // cannot advertise its customer's LAN prefix via host routing discovery.
    // The requested CIDR is only an expected DHCP lease verification range.
    // The privileged Gate agent validates the actual handoff link before
    // bridging; no unverified admin-submitted prefix authorizes a host route.

    const id = randomUUID();
    // RFC 7042 locally administered unicast address. Persisted across restarts.
    const bytes = createHash("sha256").update("rp-lan-v1:" + id).digest();
    bytes[0] = (bytes[0] & 0xfc) | 0x02;
    const macAddress = Array.from(bytes.subarray(0, 6), byte => byte.toString(16).padStart(2, "0")).join(":");
    return this.prisma.$transaction(async tx => {
      const created = await tx.remoteLanAttachment.create({
        data: {
          id, tenantId, gateId: gate.id, singleAppId: app.id, networkId: input.networkId,
          lanInterface: input.lanInterface, lanCidr: lan.normalized, macAddress,
          status: "Pending", createdBy: actor.id,
        },
      });
      const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
      await tx.auditLogEntry.create({
        data: {
          tenantId, tenantName: tenant?.name ?? "Tenant",
          actor: actor.id, actorName: actor.displayName,
          action: "remote-lan-attachment.create", resourceType: "RemoteLanAttachment",
          resourceId: created.id, resourceName: app.id, result: "Success",
          correlationId: randomUUID(),
          changes: { gateId: gate.id, singleAppId: app.id, networkId: input.networkId, lanCidr: lan.normalized },
        },
      });
      return created;
    });
  }

  async revoke(tenantId: string, id: string, actor: AuthenticatedUser) {
    const row = await this.prisma.remoteLanAttachment.findFirst({ where: { id, tenantId } });
    if (!row) throw new NotFoundException("Remote LAN attachment not found");
    // Revocation must deny control-plane grants immediately. Runtime cleanup
    // is required before deleting this durable record.
    return this.prisma.$transaction(async tx => {
      const updated = await tx.remoteLanAttachment.update({
        where: { id: row.id },
        data: { status: "Revoking", dhcpAddress: null, leaseExpiresAt: null },
      });
      const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
      await tx.auditLogEntry.create({
        data: {
          tenantId, tenantName: tenant?.name ?? "Tenant",
          actor: actor.id, actorName: actor.displayName,
          action: "remote-lan-attachment.revoke", resourceType: "RemoteLanAttachment",
          resourceId: row.id, resourceName: row.singleAppId, result: "Success",
          correlationId: randomUUID(), changes: { status: "Revoking" },
        },
      });
      return updated;
    });
  }
}
