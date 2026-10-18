import { parseIpv4Cidr } from "./network-addressing";
import { networkAttachmentAlias } from "./network-runtime-names";

export type ApplicationLanRule = {
  attachmentId: string;
  destinationCidr: string;
  protocol: "tcp" | "udp";
  port: number;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateApplicationLanRules(
  input: unknown,
  gateLanCidrs: string[],
  allowedAttachmentIds: ReadonlySet<string>,
): ApplicationLanRule[] {
  if (!Array.isArray(input) || input.length > 256) {
    throw new Error("Application LAN policy must contain at most 256 rules");
  }
  const ranges = gateLanCidrs.map(parseIpv4Cidr);
  if (ranges.some((range) => !range)) throw new Error("Gate LAN CIDRs are invalid");
  const unique = new Set<string>();
  return input.map((candidate: unknown) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("Invalid application LAN rule");
    }
    const rule = candidate as Record<string, unknown>;
    if (typeof rule.attachmentId !== "string" ||
      !UUID.test(rule.attachmentId) || !allowedAttachmentIds.has(rule.attachmentId) ||
      typeof rule.destinationCidr !== "string" ||
      (rule.protocol !== "tcp" && rule.protocol !== "udp") ||
      !Number.isInteger(rule.port) || (rule.port as number) < 1 || (rule.port as number) > 65535) {
      throw new Error("Application LAN rule has invalid source, protocol or port");
    }
    const cidr = parseIpv4Cidr(rule.destinationCidr);
    if (!cidr || !ranges.some(
      (range) => range && cidr.network >= range.network && cidr.broadcast <= range.broadcast,
    )) throw new Error("Application LAN destination is outside Gate LAN");
    const canonical: ApplicationLanRule = {
      attachmentId: rule.attachmentId,
      destinationCidr: cidr.normalized,
      protocol: rule.protocol,
      port: rule.port as number,
    };
    const key = JSON.stringify(canonical);
    if (unique.has(key)) throw new Error("Duplicate application LAN rule");
    unique.add(key);
    return canonical;
  });
}


/** Restore safe desired state after a detached app or withdrawn Gate LAN.
 * An outdated rule must never block cleanup of previously installed routes.
 * Invalid active policy fails closed to zero grants rather than publishing
 * a partially authorized snapshot.
 */
export function reconcileApplicationLanRules(
  saved: unknown,
  gateLanCidrs: string[],
  allowedAttachmentIds: ReadonlySet<string>,
): ApplicationLanRule[] {
  if (!Array.isArray(saved)) return [];
  const active = saved.filter((candidate: unknown) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const rule = candidate as Record<string, unknown>;
    if (typeof rule.attachmentId !== "string" ||
      !allowedAttachmentIds.has(rule.attachmentId) ||
      typeof rule.destinationCidr !== "string") return false;
    const destination = parseIpv4Cidr(rule.destinationCidr);
    if (!destination) return false;
    return gateLanCidrs.some(lan => {
      const range = parseIpv4Cidr(lan);
      return range && destination.network >= range.network &&
        destination.broadcast <= range.broadcast;
    });
  });
  try {
    return validateApplicationLanRules(active, gateLanCidrs, allowedAttachmentIds);
  } catch {
    return []; // Fail closed for malformed remaining rules.
  }
}

export function runtimeApplicationLanRules(rules: ApplicationLanRule[]) {
  return rules.map((rule) => ({
    attachmentAlias: networkAttachmentAlias(rule.attachmentId),
    destinationCidr: rule.destinationCidr,
    protocol: rule.protocol,
    port: rule.port,
  }));
}
