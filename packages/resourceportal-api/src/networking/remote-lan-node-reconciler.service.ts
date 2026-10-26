import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { spawnSync } from "node:child_process";
import { PrismaService } from "../prisma/prisma.service";
import { gateStackName } from "./network-runtime-names";
import { containsIpv4, parseIpv4Cidr } from "./network-addressing";
import { validateNodeLanSnapshot, type NodeLanAttachment } from "./remote-lan-node-policy";
import { normalizeSwarmCapabilityAdd } from "./swarm-capabilities";
import {verifiedManagedLan} from "./remote-lan-addressing";

const POLICY_ENV = "RESOURCEPORTAL_REMOTE_LAN_NODES_B64";

/**
 * Node-local Ethernet connections require BOTH a valid tenant attachment
 * and a RUNNING, uniquely identified Gate task connected to that exact
 * tenant overlay. A Site VPN grant is never interpreted as L2 authorization.
 *
 * This controller is dormant until the full dataplane passes certification.
 * A missing flag always publishes an empty snapshot to revoke old grants.
 */
@Injectable()
export class RemoteLanNodeReconcilerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  protected docker(args: string[]): string {
    const context = this.config.get<string>("DOCKER_CONTEXT");
    const result = spawnSync("docker", context ? ["--context", context, ...args] : args,
      { encoding: "utf8", timeout: 15000 });
    if (result.status !== 0) throw new Error("LAN agent Docker operation failed: " +
      (result.stderr || result.error?.message || result.status));
    return (result.stdout ?? "").trim();
  }

  protected async pauseForGatewayTaskChange(): Promise<void> {
    await new Promise<void>(resolve => setTimeout(resolve, 1_000));
  }

  private async taskGatewayIp(gateId: string, networkName: string, overlayCidr: string): Promise<string> {
    const network = parseIpv4Cidr(overlayCidr);
    if (!network || !/^rp-network-[0-9a-f-]{36}$/i.test(networkName))
      throw new Error("Invalid tenant overlay identity");
    const dockerNetworkId = this.docker(["network", "inspect", networkName,
      "--format", "{{.ID}}"]);
    if (!/^[a-z0-9]{12,64}$/i.test(dockerNetworkId))
      throw new Error("Missing Docker network identity");
    const serviceName = gateStackName(gateId) + "_gateway";
    // Swarm's replacement task can briefly be absent from the overlay even
    // after desired-state=running. Re-observe a bounded number of times; a
    // missing/ambiguous address never authorizes a stale or guessed endpoint.
    const observations: string[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const taskIds = this.docker(["service", "ps", "-q", "--no-trunc",
        "--filter", "desired-state=running", serviceName]).split(/\\s+/).filter(Boolean);
      const valid: string[] = [];
      let running = 0;
      let disappeared = 0;
      for (const id of taskIds) {
        if (!/^[a-z0-9]{12,64}$/i.test(id)) throw new Error("Untrusted Gate Swarm task ID");
        let task: {
          Status?: { State?: string };
          NetworksAttachments?: Array<{ Network?: { ID?: string }; Addresses?: string[] }>;
        };
        try {
          task = JSON.parse(this.docker(["inspect", "--type", "task", id,
            "--format", "{{json .}}"])) as typeof task;
        } catch (error) {
          // Tasks can disappear between service ps and inspect during a
          // legitimate rolling update; every other Docker error is fatal.
          if (!/(?:no such (?:task|object)|task .* not found)/i.test(String(error))) throw error;
          disappeared++;
          continue;
        }
        if (task.Status?.State !== "running") continue;
        running++;
        const matches = (task.NetworksAttachments ?? [])
          .filter(item => item.Network?.ID === dockerNetworkId)
          .flatMap(item => item.Addresses ?? [])
          .map(address => address.split("/")[0])
          .filter(address => containsIpv4(network, address) &&
            parseIpv4Cidr(address + "/32")?.network !== network.network &&
            parseIpv4Cidr(address + "/32")?.network !== network.broadcast);
        valid.push(...matches);
      }
      if (valid.length === 1) return valid[0];
      observations.push("attempt=" + (attempt + 1) +
        ",tasks=" + taskIds.length + ",running=" + running +
        ",addresses=" + valid.length + ",disappeared=" + disappeared);
      if (attempt < 2) await this.pauseForGatewayTaskChange();
    }
    // Diagnostic counts identify the transient failure mode without
    // publishing stale network identity, secret keys or unverified L2 grants.
    throw new Error("LAN policy requires exactly one running Gate task address on the overlay (" +
      observations.join("; ") + ")");

  }

  /**
   * A failed database authorization check must NOT preserve previously
   * distributed L2 grants. Revoke the node service policy on any error.
   */
  async reconcile() {
    try {
      return await this.reconcileAuthorized();
    } catch (error) {
      try {
        this.revokeNodeGrants();
      } catch (revokeError) {
        throw new Error("Remote LAN authorization failed and node revocation was not confirmed: " +
          String(revokeError), { cause: error });
      }
      throw error;
    }
  }

  private revokeNodeGrants() {
    const stack = this.config.get<string>("RESOURCEPORTAL_CONTROL_PLANE_STACK_NAME",
      "resourceportal-control-plane");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(stack))
      throw new Error("Invalid control-plane stack for emergency LAN revocation");
    const name = stack + "_remote-lan-node";
    const current = JSON.parse(this.docker(["service", "inspect", name,
      "--format", "{{json .Spec.TaskTemplate.ContainerSpec.Env}}"]) || "[]") as unknown;
    if (!Array.isArray(current) || !current.every(item => typeof item === "string"))
      throw new Error("Cannot verify current node policy during emergency revocation");
    const policy = POLICY_ENV + "=" + Buffer.from(
      JSON.stringify({ version: 1, attachments: [] }), "utf8").toString("base64");
    const off = "RP_REMOTE_LAN_NODE_ENABLED=false";
    if (current.includes(policy) && current.includes(off)) return;
    const removes = [POLICY_ENV, "RP_REMOTE_LAN_NODE_ENABLED"].filter(key =>
      current.some(value => value.startsWith(key + "=")));
    this.docker(["service", "update", "--detach=false",
      ...removes.flatMap(key => ["--env-rm", key]),
      "--env-add", policy, "--env-add", off, name]);
  }

  /**
   * Docker Stack cap_add is not sufficient proof of effective Swarm task
   * permissions. Set and re-read the service spec before enabling L2.
   */
  private ensureNodeCapabilities(serviceName: string) {
    const required = ["NET_ADMIN", "SYS_ADMIN", "SYS_PTRACE"];
    const inspect = ["service", "inspect", serviceName, "--format",
      "{{json .Spec.TaskTemplate.ContainerSpec.CapabilityAdd}}"];
    const read = () => normalizeSwarmCapabilityAdd(JSON.parse(this.docker(inspect) || "null") as unknown);
    const current = read();
    const missing = required.filter(cap => !current.includes(cap));
    if (missing.length) {
      // A capability upgrade restarts Swarm tasks. Never let that restart
      // load an old privileged LAN policy before the fresh tenant checks
      // and service environment rollout have completed.
      this.revokeNodeGrants();
      this.docker(["service", "update", "--detach=false",
        ...missing.flatMap(cap => ["--cap-add",cap]), serviceName]);
    }
    const actual = read();
    if (!required.every(cap => actual.includes(cap)))
      throw new Error("Remote LAN node capabilities were not applied to Swarm service");
  }

  private async reconcileAuthorized() {
    const featureOn = this.config.get<string>("REMOTE_LAN_L2_ENABLED") === "true";
    const rows = featureOn ? await this.prisma.remoteLanAttachment.findMany({
      where: { status: { in: ["Provisioning", "Active"] } },
      include: {
        gate: true,
        network: true,
        singleApp: { include: { appGroup: true } },
      },
      orderBy: { createdAt: "asc" },
    }) : [];
    const gatewayIp = new Map<string, string>();
    const records: NodeLanAttachment[] = [];

    for(const row of rows) {
      if (row.gate.tenantId !== row.tenantId || row.network.tenantId !== row.tenantId ||
          row.singleApp.appGroup.tenantId !== row.tenantId ||
          row.gate.revokedAt || row.gate.status !== "Ready" ||
          row.network.status !== "Ready" || row.singleApp.pendingDeletion ||
          row.singleApp.desiredReplicas !== 1 ||
          !["gate-l2-v1","gate-l2-v2"].includes(row.gate.agentVersion ?? "") ||
          !row.gate.serverTunnelAddress || !row.gate.clientTunnelAddress)
        throw new Error("Remote LAN attachment lacks certified Gate, app or network authorization");

      if(row.uplinkMode==="ManagedSharedUplink") {
        const segment=verifiedManagedLan(row.gateId,row.lanInterface,
          row.gate.observedLan,row.gate.observedLanAt);
        if(segment.networkCidr!==row.lanCidr)
          throw new Error("Managed Gate LAN subnet changed; revoking app grants");
      }
      const key = row.gateId + ":" + row.networkId;
      if (!gatewayIp.has(key)) {
        gatewayIp.set(key, await this.taskGatewayIp(row.gateId,
          row.network.swarmNetworkName, row.network.overlayCidr));
      }
      records.push({
        attachmentId: row.id,
        tenantId: row.tenantId,
        singleAppId: row.singleAppId,
        gateId: row.gateId,
        networkName: row.network.swarmNetworkName,
        overlayCidr: row.network.overlayCidr,
        lanCidr: row.lanCidr,
        configurationRevision: row.configurationRevision,
        uplinkMode: row.uplinkMode as "DedicatedUnnumbered"|"ManagedSharedUplink",
        addressMode: row.addressMode as "DHCP"|"Static",
        staticAddress: row.staticAddress,staticGateway: row.staticGateway,
        gatewayOverlayIp: gatewayIp.get(key)!,
        macAddress: row.macAddress,
      });
    }

    const snapshot = { version: 1, attachments: records };
    validateNodeLanSnapshot(snapshot);
    const encoded = Buffer.from(JSON.stringify(snapshot), "utf8").toString("base64");
    const stack = this.config.get<string>("RESOURCEPORTAL_CONTROL_PLANE_STACK_NAME",
      "resourceportal-control-plane");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(stack))
      throw new Error("Invalid control-plane Swarm stack name");
    const serviceName = stack + "_remote-lan-node";

    // An older platform may lack the new service. When disabled and empty,
    // there is nothing to revoke. When enabled, missing service blocks rollout.
    let current: string[];
    try {
      const decoded = JSON.parse(this.docker(["service", "inspect", serviceName,
        "--format", "{{json .Spec.TaskTemplate.ContainerSpec.Env}}"]) || "[]") as unknown;
      if (!Array.isArray(decoded) || !decoded.every(v => typeof v === "string"))
        throw new Error("Invalid node LAN service environment");
      current = decoded;
    } catch (error) {
      // An older stack may genuinely lack the service. Docker outages or
      // permission failures must NOT be misreported as safe revocation.
      if (!featureOn && records.length === 0 &&
          /(?:no such service|service .* not found)/i.test(String(error)))
        return { changed: false, attachments: 0, agentTasks: 0, disabled: true };
      throw error;
    }
    if (featureOn && records.length) {
      this.ensureNodeCapabilities(serviceName);
      // Capability changes restart the Swarm service. ensureNodeCapabilities
      // first revokes any old grants, so the environment read above is stale.
      // Re-read the actual service spec before deciding whether the desired
      // policy must be re-published. Never infer successful rollout from an
      // environment snapshot captured before emergency revocation.
      const refreshed = JSON.parse(this.docker(["service", "inspect", serviceName,
        "--format", "{{json .Spec.TaskTemplate.ContainerSpec.Env}}"]) || "[]") as unknown;
      if (!Array.isArray(refreshed) || !refreshed.every(v => typeof v === "string"))
        throw new Error("Cannot verify LAN node policy after capability reconciliation");
      current = refreshed;
    }
    const enableKey = "RP_REMOTE_LAN_NODE_ENABLED";
    const updates = [
      POLICY_ENV + "=" + encoded,
      enableKey + "=" + (featureOn ? "true" : "false"),
    ];
    const changed = updates.some(value => !current.includes(value));
    if(changed) {
      const removals = [POLICY_ENV, enableKey].filter(key =>
        current.some(value => value.startsWith(key + "=")));
      this.docker(["service","update","--detach=false",
        ...removals.flatMap(key => ["--env-rm",key]),
        ...updates.flatMap(value => ["--env-add",value]),
        serviceName]);
    }
    const states = this.docker(["service","ps","--filter","desired-state=running",
      "--format","{{.CurrentState}}",serviceName]).split("\n").filter(Boolean);
    if (featureOn && records.length > 0 &&
        (!states.length || !states.every(state => /^Running(?:\s|$)/.test(state))))
      throw new Error("Remote LAN node agent did not converge on Swarm nodes");
    return { changed, attachments: records.length, agentTasks: states.length, disabled: !featureOn };
  }
}
