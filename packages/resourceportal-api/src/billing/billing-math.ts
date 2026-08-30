import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

const MINUTES_PER_HOUR = new Prisma.Decimal(60);
const BYTES_PER_GB = new Prisma.Decimal(1_000_000_000);
const PLN_PER_CREDIT = new Prisma.Decimal("0.01");

export type EffectivePriceList = {
  id: string;
  version: number;
  effectiveFrom: Date;
};

export function assertFullMinute(value: Date) {
  if (
    Number.isNaN(value.getTime()) ||
    value.getUTCSeconds() !== 0 ||
    value.getUTCMilliseconds() !== 0
  ) {
    throw new BadRequestException("PriceListEffectiveFromMustBeFullMinute");
  }
}

export function selectEffectivePriceList<T extends EffectivePriceList>(
  versions: readonly T[],
  at: Date,
): T | undefined {
  return [...versions]
    .filter((version) => version.effectiveFrom.getTime() <= at.getTime())
    .sort((left, right) => {
      const byTime = right.effectiveFrom.getTime() - left.effectiveFrom.getTime();
      return byTime === 0 ? right.version - left.version : byTime;
    })[0];
}

export function creditsToPln(credits: Prisma.Decimal) {
  return credits.mul(PLN_PER_CREDIT);
}

export function computeMinuteCost(input: {
  billedReplicas: number;
  cpu: Prisma.Decimal;
  memoryBytes: bigint;
  gpu: number;
  cpuCreditsPerVcpuHour: Prisma.Decimal;
  memoryCreditsPerGbHour: Prisma.Decimal;
  gpuCreditsPerGpuHour: Prisma.Decimal;
}) {
  if (input.billedReplicas <= 0) {
    return new Prisma.Decimal(0);
  }

  const replicas = new Prisma.Decimal(input.billedReplicas);
  const memoryGb = new Prisma.Decimal(input.memoryBytes.toString()).div(BYTES_PER_GB);
  const perReplicaHourly = input.cpu
    .mul(input.cpuCreditsPerVcpuHour)
    .plus(memoryGb.mul(input.memoryCreditsPerGbHour))
    .plus(new Prisma.Decimal(input.gpu).mul(input.gpuCreditsPerGpuHour));

  return perReplicaHourly.mul(replicas).div(MINUTES_PER_HOUR);
}

export function storageMinuteCost(input: {
  sizeBytes: bigint;
  storageCreditsPerGbHour: Prisma.Decimal;
}) {
  const sizeGb = new Prisma.Decimal(input.sizeBytes.toString()).div(BYTES_PER_GB);
  return sizeGb.mul(input.storageCreditsPerGbHour).div(MINUTES_PER_HOUR);
}

export function clampComputeCharge(cost: Prisma.Decimal, balance: Prisma.Decimal) {
  if (cost.lte(0) || balance.lte(0)) {
    return new Prisma.Decimal(0);
  }

  return Prisma.Decimal.min(cost, balance);
}

export function closedMinutePeriod(now = new Date()) {
  const periodEnd = new Date(now);
  periodEnd.setUTCSeconds(0, 0);
  const periodStart = new Date(periodEnd.getTime() - 60_000);
  return { periodStart, periodEnd };
}
