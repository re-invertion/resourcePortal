import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import type { AuthenticatedUser } from "../auth/types";
import type { CreateRemoteLanAttachmentDto } from "./dto/create-remote-lan-attachment.dto";
import type { UpdateRemoteLanAddressingDto } from "./dto/update-remote-lan-addressing.dto";
import { normalizeLanAddress, verifiedManagedLan } from "./remote-lan-addressing";

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
    const uplinkMode = input.uplinkMode ?? "DedicatedUnnumbered";
    let addressing;
    try {
      addressing = normalizeLanAddress(input);
    } catch (error) {
      throw new BadRequestException(String(error));
    }
    if (["wg0", "rp-gate", "lo", "docker0"].includes(input.lanInterface) ||
        /^veth|^br-|^tun|^tap|^vxlan|^gretap/i.test(input.lanInterface))
      throw new BadRequestException("Remote LAN interface must be a physical Ethernet port or VLAN");
    const [gate, app, networkAttachment, existing] = await Promise.all([
      this.prisma.resourcePortalGate.findFirst({
        where: { id: input.gateId, tenantId, revokedAt: null },
        select: { id: true, agentVersion: true, observedLan: true, observedLanAt: true },
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
    if (uplinkMode === "ManagedSharedUplink") {
      if (gate.agentVersion !== "gate-l2-v2")
        throw new BadRequestException("Managed uplink requires an upgraded Gate v2 agent");
      let observed;
      try {
        observed = verifiedManagedLan(gate.id,input.lanInterface,gate.observedLan,gate.observedLanAt);
      } catch (error) {
        throw new BadRequestException(String(error));
      }
      if (addressing.lanCidr !== observed.networkCidr)
        throw new BadRequestException("Customer LAN must match the observed Gate subnet");
    } else if (addressing.addressMode === "Static") {
      throw new BadRequestException("Static LAN addressing requires a verified managed shared uplink");
    }
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
          lanInterface: input.lanInterface, lanCidr: addressing.lanCidr, macAddress,
          uplinkMode, addressMode: addressing.addressMode,
          staticAddress: addressing.staticAddress, staticGateway: addressing.staticGateway,
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
          changes: { gateId: gate.id, singleAppId: app.id, networkId: input.networkId,
            lanCidr: addressing.lanCidr, addressMode: addressing.addressMode,
            uplinkMode, staticAddress: addressing.staticAddress, staticGateway: addressing.staticGateway },
        },
      });
      return created;
    });
  }

  /**
   * Addressing transitions never change the physical Gate uplink. They remove
   * the old app/node grant via Pending before provisioning a new revision.
   * Static IP changes are reserved transactionally by the database unique key.
   */
  async updateAddressing(tenantId:string,id:string,input:UpdateRemoteLanAddressingDto,
                         actor:AuthenticatedUser) {
    const row=await this.prisma.remoteLanAttachment.findFirst({
      where:{id,tenantId},include:{gate:true}
    });
    if(!row) throw new NotFoundException("LAN Attachment not found");
    if(["Revoking","Revoked"].includes(row.status))
      throw new ConflictException("Cannot edit a revoked LAN Attachment");
    let address;
    try {
      address=normalizeLanAddress({
        lanCidr:row.lanCidr,addressMode:input.addressMode,
        staticAddress:input.staticAddress,staticGateway:input.staticGateway
      });
      if(address.addressMode==="Static") {
        if(row.uplinkMode!=="ManagedSharedUplink"||row.gate.agentVersion!=="gate-l2-v2")
          throw new Error("Static LAN requires a managed v2 Gate");
        const observed=verifiedManagedLan(row.gateId,row.lanInterface,
          row.gate.observedLan,row.gate.observedLanAt);
        if(observed.networkCidr!==row.lanCidr)
          throw new Error("Static subnet differs from current Gate observation");
      }
    } catch(error) {
      throw new BadRequestException(String(error));
    }
    if(row.addressMode===address.addressMode&&
       row.staticAddress===address.staticAddress&&row.staticGateway===address.staticGateway)
      return row;
    return this.prisma.$transaction(async tx=>{
      const updated=await tx.remoteLanAttachment.update({
        where:{id:row.id},data:{
          addressMode:address.addressMode,
          staticAddress:address.staticAddress,staticGateway:address.staticGateway,
          configurationRevision:{increment:1},status:"Pending",
          dhcpAddress:null,leaseExpiresAt:null,lastVerifiedAt:null,lastError:null
        }
      });
      const tenant=await tx.tenant.findUnique({where:{id:tenantId},select:{name:true}});
      await tx.auditLogEntry.create({data:{
        tenantId,tenantName:tenant?.name??"Tenant",
        actor:actor.id,actorName:actor.displayName,
        action:"remote-lan-attachment.addressing.update",
        resourceType:"RemoteLanAttachment",resourceId:id,resourceName:row.singleAppId,
        result:"Success",correlationId:randomUUID(),
        changes:{from:row.addressMode,to:address.addressMode,
          staticAddress:address.staticAddress,staticGateway:address.staticGateway}
      }});
      return updated;
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
