import type { GateRuntimeConfig } from "./gate-runtime.types";
import {
  gatewayL2CleanupPlan, gatewayL2SetupPlan, type GatewayL2Input, type GatewayL2Command,
} from "./remote-lan-gateway-plan";
import {
  planGatewayRuntimeAttachments, type GatewayInterface,
} from "./remote-lan-gateway-resolver";

type Run = (program: string, args: string[], allowFailure?: boolean) =>
  { status: number; stdout: string; stderr: string };

type Link = {
  ifname?: string; ifindex?: number; ifalias?: string; master?: string | number;
  linkinfo?: { info_kind?: string };
};

/**
 * Gateway L2 controller. Its run callback belongs to the existing per-Gate
 * network namespace, never the host namespace. Legacy Site VPN tasks cannot
 * authorize app Ethernet bridging. A failed desired snapshot removes all
 * previously created L2 endpoints.
 */
export class RemoteLanGatewayController {
  private readonly active = new Map<string, { input: GatewayL2Input; fingerprint: string }>();
  // Failed cleanup must block all new grants until the owner is recovered.
  private readonly pendingCleanup = new Map<string, GatewayL2Input>();
  constructor(private readonly run: Run) {}

  private links(): Link[] {
    const result = this.run("ip", ["-d", "-j", "link", "show"]);
    const decoded = JSON.parse(result.stdout || "[]") as unknown;
    if (!Array.isArray(decoded)) throw new Error("Invalid gateway link inventory");
    return decoded as Link[];
  }

  private fingerprint(input: GatewayL2Input) {
    return JSON.stringify(input);
  }

  private owner(input: GatewayL2Input): boolean {
    const expected = gatewayL2SetupPlan(input);
    const bridge = expected.find(x => x[0] === "ip" && x[1][0] === "link" &&
      x[1][1] === "set" && x[1].includes("alias"))?.[1][3];
    if (!bridge) throw new Error("Cannot resolve RP gateway bridge");
    const link = this.links().find(x => x.ifname === bridge);
    if (!link) return false;
    if (link.ifalias !== "rp-lan-gateway:" + input.app.attachmentId ||
        link.linkinfo?.info_kind !== "bridge")
      throw new Error("Refusing to adopt unrelated Gateway bridge");
    return true;
  }

  private executePlan(commands: readonly GatewayL2Command[], created: Set<string>) {
    for (const [program, args] of commands) {
      if (program === "nft" && args[0] === "add" && args[1] === "table") {
        const current = this.run("nft", ["list", "table", "bridge", "rp_lan_gw"], true);
        if (current.status === 0) continue;
      }
      this.run(program, [...args]);
      if (program === "ip" && args[0] === "link" && args[1] === "add")
        created.add(args[2]);
    }
  }

  private detach(input: GatewayL2Input) {
    const commands = gatewayL2CleanupPlan(input);
    // A crashed/partially removed bridge may leave live GRETAP endpoints.
    // Never mistake the missing ownership anchor for successful revocation.
    const links = this.links();
    const bridgeName = commands[2]?.[1][2];
    if (!bridgeName) throw new Error("Cannot resolve Gateway cleanup bridge");
    const bridge = links.find(x => x.ifname === bridgeName);
    if (bridge && !this.owner(input))
      throw new Error("Refusing deletion of an unowned Gateway bridge");
    const endpoints = commands.slice(0, 2).map(([, args], index) => {
      const link = links.find(x => x.ifname === args[2]);
      const alias = (index === 0 ? "rp-lan-app:" : "rp-lan-wg:") + input.app.attachmentId;
      if (link && (link.linkinfo?.info_kind !== "gretap" || link.ifalias !== alias))
        throw new Error("Refusing deletion of a foreign Gateway GRETAP interface");
      if (link && link.master !== undefined &&
          link.master !== bridgeName &&
          !(bridge && typeof bridge.ifindex === "number" && link.master === bridge.ifindex))
        throw new Error("Refusing deletion of a Gateway tunnel enslaved to a foreign bridge");
      return link;
    });
    if (!bridge && endpoints.every(link => !link)) return;
    for (const [program,args] of commands) {
      if (!bridge && program === "ip" && args[2] === bridgeName) continue;
      const result = this.run(program,[...args],true);
      if (result.status !== 0 && !/No such file|Cannot find device|not found/i.test(result.stderr)) {
        throw new Error("Gateway LAN revocation command failed: " + program);
      }
    }
  }

  private attach(input: GatewayL2Input) {
    const commands = gatewayL2SetupPlan(input);
    const createdNames = commands.filter(([program, args]) =>
      program === "ip" && args[0] === "link" && args[1] === "add")
      .map(([, args]) => args[2]);
    const [bridge, appDev, wgDev] = createdNames;
    if (!bridge || !appDev || !wgDev || createdNames.length !== 3)
      throw new Error("Invalid Gateway LAN creation plan");
    const before = this.links();
    if (before.some(link => link.ifname === bridge)) {
      // A restart can leave a correctly owner-tagged bridge behind. Revoke
      // it before rebuilding; never blindly adopt an unverified dataplane.
      if (!this.owner(input)) throw new Error("Refusing unowned Gateway bridge");
      this.detach(input);
    }
    if (this.links().some(link => createdNames.includes(link.ifname ?? "")))
      throw new Error("Gateway LAN endpoint name is already occupied");
    const created = new Set<string>();
    try {
      this.executePlan(commands, created);
    } catch (error) {
      try {
        const existing = this.links();
        // An alias command can fail immediately after creating its GRETAP.
        // Only remove such an untagged link when THIS invocation created it,
        // it is still unmastered, and its kernel type is exactly GRETAP.
        for (const name of [appDev, wgDev]) {
          const link = existing.find(item => item.ifname === name);
          if (created.has(name) && link && !link.ifalias) {
            if (link.linkinfo?.info_kind !== "gretap" || link.master)
              throw new Error("Cannot safely clean a changed partial Gateway tunnel");
            this.run("ip", ["link", "delete", name]);
          }
        }
        const owner = existing.find(item => item.ifname === bridge);
        if (created.has(bridge) && owner && !owner.ifalias) {
          // Bridge alias is the second setup command, before ANY tunnels.
          if (owner.linkinfo?.info_kind !== "bridge" || owner.master)
            throw new Error("Cannot safely clean a changed partial Gateway bridge");
          this.run("ip", ["link", "delete", bridge]);
        } else {
          this.detach(input);
        }
      } catch (cleanupError) {
        this.pendingCleanup.set(input.app.attachmentId, input);
        throw new Error("Gateway LAN setup failed and cleanup is incomplete: " +
          String(cleanupError), { cause: error });
      }
      throw error;
    }
  }

  reconcile(
    runtime: GateRuntimeConfig, interfaces: readonly GatewayInterface[],
    tasksByService: ReadonlyMap<string,readonly string[]>,
    enabled: boolean,
  ): number {
    let desired: GatewayL2Input[] = [];
    let denied: Error | null = null;
    try {
      if (!enabled && runtime.remoteLanAttachments?.length)
        throw new Error("Remote LAN gateway runtime is not certified or enabled");
      desired = enabled ? planGatewayRuntimeAttachments(runtime,interfaces,tasksByService) : [];
      // Validate every command plan before changing ANY network interface.
      for(const input of desired) gatewayL2SetupPlan(input);
    } catch (error) {
      denied = error instanceof Error ? error : new Error("Invalid gateway desired state");
    }
    // Never grant new L2 access while a prior partial rollback is unresolved.
    for (const [id, input] of this.pendingCleanup) {
      this.detach(input);
      this.pendingCleanup.delete(id);
    }
    const lookup = new Map(desired.map(input=>[input.app.attachmentId,input]));
    for (const [id,previous] of this.active) {
      const next = lookup.get(id);
      if (next && this.fingerprint(next) === previous.fingerprint) continue;
      this.detach(previous.input);
      this.active.delete(id);
    }
    if (denied) throw denied;
    for(const [id,input] of lookup) {
      if(this.active.has(id)) continue;
      this.attach(input);
      this.active.set(id,{input,fingerprint:this.fingerprint(input)});
    }
    return this.active.size;
  }

  stop() {
    for(const [id,entry] of this.active) {
      this.detach(entry.input);
      this.active.delete(id);
    }
  }
}
