import { networkAttachmentAlias } from "./network-runtime-names";

export type GateDiscoveryRule = {
  attachmentId: string;
  protocol: "mdns" | "ssdp";
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Discovery relay is explicit, scoped per Site VPN, RP Network and SingleApp. */
export function validateGateDiscoveryRules(
  raw: unknown, allowedAttachmentIds: ReadonlySet<string>,
): GateDiscoveryRule[] {
  if (!Array.isArray(raw) || raw.length > 128) throw new Error("Invalid discovery policy size");
  const distinct = new Set<string>();
  return raw.map((input: unknown) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid discovery rule");
    const value = input as Record<string, unknown>;
    if (typeof value.attachmentId !== "string" ||
      !UUID.test(value.attachmentId) ||
      !allowedAttachmentIds.has(value.attachmentId) ||
      (value.protocol !== "mdns" && value.protocol !== "ssdp")) {
      throw new Error("Discovery rule references an unauthorized application/protocol");
    }
    const key = value.attachmentId + ":" + value.protocol;
    if (distinct.has(key)) throw new Error("Duplicate discovery rule");
    distinct.add(key);
    return { attachmentId: value.attachmentId, protocol: value.protocol };
  });
}

export function runtimeGateDiscoveryRules(rules: GateDiscoveryRule[]) {
  return rules.map(rule => ({
    attachmentAlias: networkAttachmentAlias(rule.attachmentId),
    protocol: rule.protocol,
  }));
}
