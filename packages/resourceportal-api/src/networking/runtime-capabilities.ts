import { readFileSync } from "node:fs";

// Linux capability numbers: CAP_NET_ADMIN=12, CAP_NET_RAW=13,
// CAP_SYS_ADMIN=21, CAP_SYS_PTRACE=19. Validate the effective set, not UID or a Compose file.
const CAPABILITY_NUMBERS = {
  NET_ADMIN: 12n,
  NET_RAW: 13n,
  SYS_ADMIN: 21n,
  SYS_PTRACE: 19n,
} as const;
export type RuntimeCapability = keyof typeof CAPABILITY_NUMBERS;

export function missingEffectiveCapabilities(
  statusText: string,
  required: readonly RuntimeCapability[],
): RuntimeCapability[] {
  const match = /^CapEff:\s*([0-9a-fA-F]+)\s*$/m.exec(statusText);
  if (!match?.[1]) throw new Error("Linux effective capabilities are unavailable");
  const effective = BigInt("0x" + match[1]);
  return required.filter(name => (effective & (1n << CAPABILITY_NUMBERS[name])) === 0n);
}

export function requireEffectiveCapabilities(role: string, required: readonly RuntimeCapability[]) {
  const missing = missingEffectiveCapabilities(readFileSync("/proc/self/status", "utf8"), required);
  if (missing.length) {
    throw new Error(
      `${role} missing effective Linux capabilities: ${missing.join(", ")}. Check Swarm service task specification (CapabilityAdd).`,
    );
  }
}
