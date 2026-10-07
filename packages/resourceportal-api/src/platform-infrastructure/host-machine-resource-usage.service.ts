import { Injectable } from "@nestjs/common";
import { readFile } from "node:fs/promises";

type CpuSnapshot = {
  idle: bigint;
  total: bigint;
};

export type HostMachineResourceUsage = {
  cpuUsedRatio: number;
  cpuCount: number;
  memoryUsedBytes: bigint;
  memoryTotalBytes: bigint;
  observedAt: Date;
};

@Injectable()
export class HostMachineResourceUsageService {
  async observe(): Promise<HostMachineResourceUsage> {
    const [firstStat, memoryInfo] = await Promise.all([
      readFile("/proc/stat", "utf8"),
      readFile("/proc/meminfo", "utf8"),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const secondStat = await readFile("/proc/stat", "utf8");

    const first = parseCpuSnapshot(firstStat);
    const second = parseCpuSnapshot(secondStat);
    const memory = parseMemoryInfo(memoryInfo);
    const cpuCount = parseCpuCount(secondStat);

    const totalDelta = second.total - first.total;
    const idleDelta = second.idle - first.idle;
    const busyDelta = totalDelta > idleDelta ? totalDelta - idleDelta : 0n;
    const cpuUsedRatio =
      totalDelta > 0n ? Number(busyDelta) / Number(totalDelta) : 0;

    return {
      cpuUsedRatio: Math.min(1, Math.max(0, cpuUsedRatio)),
      cpuCount,
      memoryUsedBytes: memory.usedBytes,
      memoryTotalBytes: memory.totalBytes,
      observedAt: new Date(),
    };
  }
}

export function parseCpuSnapshot(input: string): CpuSnapshot {
  const line = input
    .split("\n")
    .find((candidate) => candidate.startsWith("cpu "));
  if (!line) throw new Error("Host /proc/stat does not contain aggregate CPU data");

  const values = line
    .trim()
    .split(/\s+/)
    .slice(1, 9)
    .map((value) => BigInt(value));
  if (values.length < 4) throw new Error("Host /proc/stat CPU data is incomplete");

  const total = values.reduce((sum, value) => sum + value, 0n);
  const idle = values[3] + (values[4] ?? 0n);
  return { idle, total };
}

export function parseCpuCount(input: string) {
  const count = input
    .split("\n")
    .filter((line) => /^cpu\d+\s/.test(line)).length;
  if (count < 1) throw new Error("Host /proc/stat does not contain per-CPU data");
  return count;
}

export function parseMemoryInfo(input: string) {
  const values = new Map<string, bigint>();
  for (const line of input.split("\n")) {
    const match = /^([A-Za-z_()]+):\s+(\d+)\s+kB$/.exec(line.trim());
    if (match) values.set(match[1], BigInt(match[2]) * 1024n);
  }

  const totalBytes = values.get("MemTotal");
  const availableBytes = values.get("MemAvailable") ?? values.get("MemFree");
  if (totalBytes === undefined || availableBytes === undefined) {
    throw new Error("Host /proc/meminfo does not contain memory capacity data");
  }

  return {
    totalBytes,
    availableBytes,
    usedBytes: totalBytes > availableBytes ? totalBytes - availableBytes : 0n,
  };
}
