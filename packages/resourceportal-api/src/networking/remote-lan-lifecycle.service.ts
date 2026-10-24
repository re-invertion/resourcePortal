import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import {verifiedManagedLan} from "./remote-lan-addressing";

/**
 * Desired-state handoff, not DHCP proof. A Pending attachment can only enter
 * Provisioning after an explicitly certified L2 Gate is ready. DHCP lease
 * evidence from both authenticated peers is required separately for Active.
 *
 * Revoking is intentionally never marked Revoked by this service because a
 * successful remote/kernel teardown acknowledgement is not yet available.
 */
@Injectable()
export class RemoteLanLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async reconcile() {
    if (this.config.get<string>("REMOTE_LAN_L2_ENABLED") !== "true")
      return { provisioned: 0, waiting: 0, disabled: true };

    const pending = await this.prisma.remoteLanAttachment.findMany({
      where: { status: "Pending" },
      include: {
        gate: true,
        network: true,
        singleApp: {
          include: { appGroup: true,
            networkAttachments: true },
        },
      },
    });
    let provisioned = 0;
    let waiting = 0;
    for (const row of pending) {
      let managedReady=true;
      if(row.uplinkMode==="ManagedSharedUplink") {
        try {
          const observed=verifiedManagedLan(row.gateId,row.lanInterface,
            row.gate.observedLan,row.gate.observedLanAt);
          managedReady=observed.networkCidr===row.lanCidr;
        } catch { managedReady=false; }
      }
      const ready = managedReady &&
        row.gate.tenantId === row.tenantId &&
        row.network.tenantId === row.tenantId &&
        row.singleApp.appGroup.tenantId === row.tenantId &&
        row.gate.revokedAt === null &&
        row.gate.status === "Ready" &&
        ["gate-l2-v1","gate-l2-v2"].includes(row.gate.agentVersion ?? "") &&
        row.network.status === "Ready" &&
        row.singleApp.pendingDeletion === false &&
        row.singleApp.desiredReplicas === 1 &&
        row.singleApp.networkAttachments.some(link => link.networkId === row.networkId) &&
        // Dedicated unnumbered LAN handoffs have NO routable Gate-side
        // prefix to report. The Gate enforces the physical link boundary.
        !!row.gate.serverTunnelAddress && !!row.gate.clientTunnelAddress;
      if (!ready) {
        waiting += 1;
        continue;
      }
      const claimed = await this.prisma.remoteLanAttachment.updateMany({
        where: { id: row.id, tenantId: row.tenantId, status: "Pending" },
        data: {
          status: "Provisioning",
          lastError: null,
          dhcpAddress: null,
          leaseExpiresAt: null,
        },
      });
      if (claimed.count === 1) provisioned += 1;
    }
    return { provisioned, waiting, disabled: false };
  }
}
