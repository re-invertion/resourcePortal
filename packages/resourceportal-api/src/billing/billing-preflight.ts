import { Prisma } from "@prisma/client";

export type SingleAppCostShape = {
  cpu: string | number | Prisma.Decimal;
  memoryBytes: bigint;
  gpu: number;
  desiredReplicas: number;
};

export type SingleAppCostUpdate = {
  cpu?: number;
  memoryBytes?: number;
  gpu?: number;
  desiredReplicas?: number;
};

export function isCostIncreasingSingleAppUpdate(
  current: SingleAppCostShape,
  update: SingleAppCostUpdate,
) {
  if (
    update.cpu !== undefined &&
    new Prisma.Decimal(update.cpu).gt(new Prisma.Decimal(current.cpu))
  ) {
    return true;
  }

  if (
    update.memoryBytes !== undefined &&
    BigInt(update.memoryBytes) > current.memoryBytes
  ) {
    return true;
  }

  if (update.gpu !== undefined && update.gpu > current.gpu) {
    return true;
  }

  return (
    update.desiredReplicas !== undefined &&
    update.desiredReplicas > current.desiredReplicas
  );
}

export function isCostIncreasingVolumeResize(
  currentSizeBytes: bigint,
  requestedSizeBytes: number,
) {
  return BigInt(requestedSizeBytes) > currentSizeBytes;
}
