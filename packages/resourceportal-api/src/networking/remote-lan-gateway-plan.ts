import { createHash } from "node:crypto";
import { appGretapCommands, type AppL2Tunnel } from "./remote-lan-app-dataplane";
import { gretapSetupCommands, type RemoteLanTunnel } from "./remote-lan-l2-transport";

/**
 * Plan for a single RP gateway container's private per-app bridge.
 * Both Ethernet tunnels live INSIDE the Gate container namespace:
 *   app task --Swarm overlay GRETAP--> RP gateway bridge
 *   RP gateway bridge --WG GRETAP--> customer's RP Gate bridge
 *
 * Unlike Site VPN, no RP overlay or customer LAN is routed at L3.
 */
export type GatewayL2Input = {
  app: AppL2Tunnel;
  wireguard: RemoteLanTunnel;
};
export type GatewayL2Command = readonly [
  binary: "ip" | "nft",
  args: readonly string[],
];

function names(input: GatewayL2Input) {
  if (input.app.side !== "gateway" || input.wireguard.side !== "resourceportal" ||
      input.app.tenantId !== input.wireguard.tenantId ||
      input.app.gateId !== input.wireguard.gateId ||
      input.app.attachmentId !== input.wireguard.attachmentId)
    throw new Error("Cross-tenant or cross-Gate bridge is prohibited");
  const hash = createHash("sha256").update(
    [input.app.tenantId, input.app.gateId, input.app.attachmentId].join(":"),
  ).digest("hex");
  return { bridge: "rp-b-" + hash.slice(0,8), chain: "rp_" + hash.slice(0,12) };
}

export function gatewayL2SetupPlan(input: GatewayL2Input): GatewayL2Command[] {
  const { bridge, chain } = names(input);
  const app = appGretapCommands(input.app);
  const wireguard = gretapSetupCommands(input.wireguard);
  const appDev = app[0][1][2];
  const wireguardDev = wireguard[0][1][2];
  const mac = input.app.macAddress.toLowerCase();
  // The bridge isn't attached to either tunnel until its ingress firewall is ready.
  const commands: GatewayL2Command[] = [
    // Create and tag the ownership anchor first. A failed subsequent tunnel
    // setup can then be revoked without leaving an untracked GRETAP endpoint.
    ["ip",["link","add",bridge,"type","bridge","stp_state","1"]],
    ["ip",["link","set","dev",bridge,"alias","rp-lan-gateway:" + input.app.attachmentId]],
    app[0],
    ["ip",["link","set","dev",appDev,"alias","rp-lan-app:" + input.app.attachmentId]],
    ...app.slice(1),
    wireguard[0],
    ["ip",["link","set","dev",wireguardDev,"alias","rp-lan-wg:" + input.app.attachmentId]],
    ...wireguard.slice(1),
    ["nft",["add","table","bridge","rp_lan_gw"]],
    ["nft",["add","chain","bridge","rp_lan_gw",chain,
      "{","type","filter","hook","forward","priority","-300",";","policy","accept",";","}"]],
  ];
  const start=["add","rule","bridge","rp_lan_gw",chain,"iifname",appDev];
  for (const suffix of [
    ["ether","saddr","!=",mac,"drop"],
    ["ether","type","vlan","drop"],
    ["ether","type","0x88a8","drop"],
    ["ether","type","ip6","drop"],
    ["ether","type","ip","udp","sport","67","drop"],
    ["ether","daddr","01:80:c2:00:00:00","drop"],
  ]) {
    commands.push(["nft",[...start,...suffix]]);
  }
  commands.push(
    ["ip",["link","set","dev",appDev,"master",bridge]],
    ["ip",["link","set","dev",wireguardDev,"master",bridge]],
    ["ip",["link","set","dev",bridge,"up"]],
  );
  return commands;
}

/**
 * Only RP-owned names should be passed to runtime command execution after
 * netlink confirms their ownership and exact GRETAP local/remote parameters.
 */
export function gatewayL2CleanupPlan(input: GatewayL2Input): GatewayL2Command[] {
  const { bridge, chain } = names(input);
  const appDev = appGretapCommands(input.app)[0][1][2];
  const wireguardDev = gretapSetupCommands(input.wireguard)[0][1][2];
  return [
    ["ip",["link","delete",appDev]],
    ["ip",["link","delete",wireguardDev]],
    ["ip",["link","delete",bridge]],
    ["nft",["flush","chain","bridge","rp_lan_gw",chain]],
    ["nft",["delete","chain","bridge","rp_lan_gw",chain]],
  ];
}
