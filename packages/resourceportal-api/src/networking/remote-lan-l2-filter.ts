import { createHash } from "node:crypto";

/**
 * nftables bridge-family ingress policy for an RP-owned, per-app GRETAP
 * endpoint on the customer's Gate. This MUST be installed before the
 * endpoint is attached to a live LAN bridge (no transient open forwarding).
 *
 * The caller authenticates the Gate and resolves device ownership; this
 * module does not authorize the attachment by itself.
 */
export type RemoteLanIngressFilter = {
  attachmentId: string;
  tenantId: string;
  gateId: string;
  gretapDevice: string;
  allowedMac: string;
};
type NftCommand = readonly [binary: "nft", args: readonly string[]];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ifname = /^rp-l2-[0-9a-f]{8}$/;
const mac = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;

export function remoteLanIngressChain(input: RemoteLanIngressFilter): string {
  if (![input.attachmentId, input.tenantId, input.gateId].every(id => uuid.test(id)) ||
      !ifname.test(input.gretapDevice) || !mac.test(input.allowedMac) ||
      (parseInt(input.allowedMac.slice(0,2),16) & 3) !== 2)
    throw new Error("Invalid Gate L2 ingress policy identity");
  const digest = createHash("sha256").update(
    [input.tenantId,input.gateId,input.attachmentId].join(":")).digest("hex");
  if (input.gretapDevice !== "rp-l2-" + digest.slice(0,8))
    throw new Error("L2 ingress interface is not bound to the expected attachment");
  return "rp_" + digest.slice(0,12);
}

/** Bootstrap once in the Gate namespace; do not recreate this shared table per app. */
export function remoteLanFilterTableSetup(): NftCommand {
  return ["nft",["add","table","bridge","rp_lan"]];
}

export function remoteLanIngressFilterPlan(input: RemoteLanIngressFilter): NftCommand[] {
  const chain = remoteLanIngressChain(input);
  const iface = input.gretapDevice;
  const prefix = ["add","rule","bridge","rp_lan",chain,"iifname",iface];
  return [
    ["nft",["add","chain","bridge","rp_lan",chain,
      "{","type","filter","hook","forward","priority","-300",";","policy","accept",";","}"]],
    // Fail closed for all packets not carrying the one assigned application MAC.
    ["nft",[...prefix,"ether","saddr","!=" ,input.allowedMac.toLowerCase(),"drop"]],
    // Do not permit VLAN hopping, including provider-tagged frames.
    ["nft",[...prefix,"ether","type","vlan","drop"]],
    ["nft",[...prefix,"ether","type","0x88a8","drop"]],
    // Initial feature supports IPv4 DHCP only. Never accept IPv6 RAs from apps.
    ["nft",[...prefix,"ether","type","ip6","drop"]],
    // A tenant application must not advertise itself as a LAN DHCP server.
    ["nft",[...prefix,"ether","type","ip","udp","sport","67","drop"]],
    // Never allow an app to inject spanning-tree BPDUs into the physical LAN.
    ["nft",[...prefix,"ether","daddr","01:80:c2:00:00:00","drop"]],
  ];
}

/** Only delete the chain matching this exact attachment; never flush a shared table. */
export function remoteLanIngressFilterCleanup(input: RemoteLanIngressFilter): NftCommand[] {
  return [["nft",["delete","chain","bridge","rp_lan",remoteLanIngressChain(input)]]];
}
