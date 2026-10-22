/**
 * Docker Engine canonicalizes CapabilityAdd values to CAP_* on service
 * inspect, even when service create/update took an unprefixed CLI argument.
 */
export function normalizeSwarmCapabilityAdd(value: unknown): string[] {
  if (value === null) return [];
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) {
    throw new Error("Malformed Swarm CapabilityAdd inspection");
  }
  return value.map((name: string) => name.toUpperCase().replace(/^CAP_/, ""));
}
