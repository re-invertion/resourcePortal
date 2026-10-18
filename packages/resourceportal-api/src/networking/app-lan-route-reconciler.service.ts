import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { spawnSync } from "node:child_process";
import { PrismaService } from "../prisma/prisma.service";
import { gateStackName } from "./network-runtime-names";
import { validateApplicationLanRules } from "./gate-application-access";
import { validateLanRoutePolicy, type ApplicationLanRoute } from "./app-lan-routes";
import { containsIpv4, parseIpv4Cidr } from "./network-addressing";

const POLICY_ENV = "RESOURCEPORTAL_APP_LAN_ROUTES_B64";

/**
 * Reconciles a routing snapshot independently of tenant service images.
 * No route is created until the Gate, network, firewall and app attachment
 * all agree on the desired state.
 */
@Injectable()
export class AppLanRouteReconcilerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  protected docker(args: string[]) {
    const context = this.config.get<string>("DOCKER_CONTEXT");
    const actual = context ? ["--context", context, ...args] : args;
    const result = spawnSync("docker", actual, { encoding: "utf8", timeout: 15000 });
    if (result.status !== 0) throw new Error("Docker route reconciliation: " + (result.stderr || result.error?.message));
    return (result.stdout ?? "").trim();
  }

  private gatewayTaskAddress(gateId: string, networkName: string, overlayCidr: string) {
    const dockerNetworkId = this.docker(["network", "inspect", networkName, "--format", "{{.ID}}"]);
    const name = gateStackName(gateId) + "_gateway";
    const tasks = this.docker([
      "service", "ps", "-q", "--no-trunc",
      "--filter", "desired-state=running", name,
    ]).split(/\s+/).filter(Boolean);
    const cidr = parseIpv4Cidr(overlayCidr);
    if (!cidr) throw new Error("Invalid Gate overlay CIDR");
    for (const id of tasks) {
      const task = JSON.parse(this.docker(["inspect", id, "--format", "{{json .}}"])) as {
        Status?: { State?: string };
        NetworksAttachments?: Array<{
          Network?: { ID?: string }; Addresses?: string[];
        }>;
      };
      if (task.Status?.State !== "running") continue;
      const attachment = task.NetworksAttachments?.find(link => link.Network?.ID === dockerNetworkId);
      const address = attachment?.Addresses?.[0]?.split("/")[0];
      if (address && containsIpv4(cidr, address)) return address;
    }
    throw new Error("No running Site VPN task IP on the application overlay");
  }

  async reconcile() {
    const gates = await this.prisma.resourcePortalGate.findMany({
      where: {
        revokedAt: null,
        status: "Ready",
        allowRpToLan: true,
        applicationAccessMode: "PerApplication",
      },
      include: {
        networks: {
          where: { enabled: true, status: "Ready" },
          include: { network: { include: { attachments: { include: { singleApp: true } } } } },
        },
      },
    });
    const routes: ApplicationLanRoute[] = [];
    for (const gate of gates) {
      if (gate.agentVersion !== "gate-shell-v3") continue;
      const attachments = gate.networks.flatMap(link => link.network.attachments);
      const approved = validateApplicationLanRules(
        gate.applicationLanPolicies,
        gate.lanCidrs,
        new Set(attachments.map(attachment => attachment.id)),
      );
      const gatewayByNetwork = new Map<string, string>();
      for (const rule of approved) {
        const link = gate.networks.find(item =>
          item.network.attachments.some(attachment => attachment.id === rule.attachmentId),
        );
        if (!link) throw new Error("App LAN access is not attached to its Site VPN");
        const app = link.network.attachments.find(item => item.id === rule.attachmentId);
        if (!app) throw new Error("App LAN access attachment disappeared");
        if (!gatewayByNetwork.has(link.network.id)) {
          gatewayByNetwork.set(
            link.network.id,
            this.gatewayTaskAddress(gate.id, link.network.swarmNetworkName, link.network.overlayCidr),
          );
        }
        routes.push({
          tenantId: gate.tenantId,
          singleAppId: app.singleAppId,
          swarmServiceName: "rp_" + app.singleApp.appGroupId.replaceAll("-", "_") + "_" +
            app.singleApp.name.replaceAll("-", "_"),
          networkName: link.network.swarmNetworkName,
          sourceNetworkCidr: link.network.overlayCidr,
          destinationCidr: rule.destinationCidr,
          gatewayAddress: gatewayByNetwork.get(link.network.id)!,
        });
      }
    }
    // Validate overlap across distinct sites rather than silently selecting
    // the last, potentially hostile, route for a private destination.
    for (let i = 0; i < routes.length; i++) {
      for (let j = i + 1; j < routes.length; j++) {
        const a = routes[i];
        const b = routes[j];
        if (a.singleAppId !== b.singleAppId) continue;
        const cidrA = parseIpv4Cidr(a.destinationCidr);
        const cidrB = parseIpv4Cidr(b.destinationCidr);
        if (cidrA && cidrB && cidrA.network <= cidrB.broadcast &&
          cidrB.network <= cidrA.broadcast &&
          (a.gatewayAddress !== b.gatewayAddress || a.networkName !== b.networkName)) {
          throw new Error("Overlapping application LAN routes across Site VPNs");
        }
      }
    }
    const policy = { version: 1, routes: validateLanRoutePolicy({ version: 1, routes }) };
    const encoded = Buffer.from(JSON.stringify(policy)).toString("base64");
    const stack = this.config.get<string>(
      "RESOURCEPORTAL_CONTROL_PLANE_STACK_NAME", "resourceportal-control-plane",
    );
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(stack)) {
      throw new Error("Invalid RP control-plane Swarm stack name");
    }
    const serviceName = this.config.get<string>("APP_LAN_ROUTER_SERVICE_NAME") ||
      stack + "_app-lan-router";
    const existing = JSON.parse(this.docker([
      "service", "inspect", serviceName, "--format", "{{json .Spec.TaskTemplate.ContainerSpec.Env}}",
    ]) || "[]") as string[];
    const previous = existing.find(item => item.startsWith(POLICY_ENV + "="));
    if (previous === POLICY_ENV + "=" + encoded) return { changed: false, routes: policy.routes.length };
    this.docker([
      "service", "update",
      ...(previous ? ["--env-rm", POLICY_ENV] : []),
      "--env-add", POLICY_ENV + "=" + encoded, serviceName,
    ]);
    return { changed: true, routes: policy.routes.length };
  }
}
