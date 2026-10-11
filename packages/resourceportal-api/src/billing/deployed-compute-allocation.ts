import { Prisma } from "@prisma/client";

export type DeployedComputeAllocation = {
  desiredReplicas: number;
  cpu: Prisma.Decimal;
  memoryBytes: bigint;
  gpu: number;
  runtimeState: string;
};

/**
 * A mutable SingleApp draft is NEVER authoritative for compute metering.
 * Returns null only for apps absent from the deployed snapshot (new draft).
 * Missing/unparseable currently deployed snapshots fail closed so that a bad
 * record cannot silently advance billing state with a zero charge.
 */
export function deployedComputeAllocation(
  stackConfig: string,
  singleAppId: string,
): DeployedComputeAllocation | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stackConfig) as unknown;
  } catch {
    throw new Error("BillingDeployedSnapshotInvalid");
  }
  if (!parsed || typeof parsed !== "object" ||
      !("singleApps" in parsed) || !Array.isArray(parsed.singleApps)) {
    throw new Error("BillingDeployedSnapshotInvalid");
  }
  const rawApps: unknown[] = parsed.singleApps;
  const matches = rawApps.filter((item) =>
    item !== null && typeof item === "object" && "id" in item && item.id === singleAppId);
  if (matches.length > 1) throw new Error("BillingDuplicateDeployedApp");
  if (matches.length === 0) return null;
  const value = matches[0];
  if (!value || typeof value !== "object" || !("resources" in value) ||
      !value.resources || typeof value.resources !== "object" ||
      !("cpu" in value.resources) || !("memoryBytes" in value.resources) ||
      !("gpu" in value.resources) ||
      !("desiredReplicas" in value) || !("runtimeState" in value)) {
    throw new Error("BillingDeployedResourceInvalid");
  }
  const resources = value.resources;
  if (typeof resources.cpu !== "string" ||
      typeof resources.memoryBytes !== "string" ||
      typeof resources.gpu !== "number" || !Number.isInteger(resources.gpu) ||
      resources.gpu < 0 ||
      typeof value.desiredReplicas !== "number" ||
      !Number.isInteger(value.desiredReplicas) || value.desiredReplicas < 0 ||
      (value.runtimeState !== "Running" && value.runtimeState !== "Stopped") ||
      !/^\d+$/.test(resources.memoryBytes)) {
    throw new Error("BillingDeployedResourceInvalid");
  }
  try {
    const cpu = new Prisma.Decimal(resources.cpu);
    const memoryBytes = BigInt(resources.memoryBytes);
    if (!cpu.isFinite() || cpu.lte(0) || memoryBytes <= 0n) {
      throw new Error("BillingDeployedResourceInvalid");
    }
    return {
      desiredReplicas: value.desiredReplicas,
      runtimeState: value.runtimeState,
      cpu, memoryBytes, gpu: resources.gpu,
    };
  } catch {
    throw new Error("BillingDeployedResourceInvalid");
  }
}
