import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  compactMemoryObservations,
  DEFAULT_CAPACITY_POLICY,
  type CapacityPolicy,
  type MemoryObservation,
} from "./capacity-hybrid.logic";

type StoredObservation = Omit<
  MemoryObservation,
  | "memoryCurrentBytes"
  | "memoryPeakBytes"
  | "startupPeakBytes"
  | "oomEvents"
  | "nodeMemoryAvailableBytes"
  | "nodeMemoryTotalBytes"
> & {
  memoryCurrentBytes: string;
  memoryPeakBytes: string;
  startupPeakBytes?: string;
  oomEvents: string;
  nodeMemoryAvailableBytes?: string;
  nodeMemoryTotalBytes?: string;
};

const DAY_MS = 86_400_000;
const COMPACT_INTERVAL_MS = 60 * 60_000;
const STALE_LOCK_MS = 2 * 60_000;

@Injectable()
export class CapacityTelemetryStore {
  private cache?: MemoryObservation[];
  private queue = Promise.resolve();
  private lastCompactedAt = 0;
  private lastKnownMtimeMs = 0;

  constructor(private readonly config: ConfigService) {}

  async append(points: MemoryObservation[], policy = DEFAULT_CAPACITY_POLICY) {
    if (points.length === 0) return;
    await this.serialized(async () => {
      await this.withLock(async () => {
        await this.reloadIfChanged();
        const path = this.path();
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const normalized = points.map((point) => this.normalize(point));
        const payload =
          normalized
            .map((point) => JSON.stringify(this.encode(point)))
            .join("\n") + "\n";
        await appendFile(path, payload, { encoding: "utf8", mode: 0o600 });
        this.cache = [...(this.cache ?? []), ...normalized];
        this.lastKnownMtimeMs = Date.now();
        if (Date.now() - this.lastCompactedAt >= COMPACT_INTERVAL_MS) {
          await this.compact(policy);
        }
      });
    });
  }

  async appHistory(appId: string, sinceMs = Date.now() - 90 * DAY_MS) {
    const observations = await this.observations();
    return observations.filter(
      (item) => item.appId === appId && Date.parse(item.observedAt) >= sinceMs,
    );
  }

  async nodeHistory(nodeId: string, sinceMs = Date.now() - 90 * DAY_MS) {
    const observations = await this.observations();
    return observations.filter(
      (item) =>
        item.nodeId === nodeId &&
        item.appId === undefined &&
        Date.parse(item.observedAt) >= sinceMs,
    );
  }

  async latestNodes() {
    const observations = await this.observations();
    const latest = new Map<string, MemoryObservation>();
    for (const point of observations) {
      if (point.appId !== undefined) continue;
      const previous = latest.get(point.nodeId);
      if (!previous || Date.parse(point.observedAt) > Date.parse(previous.observedAt)) {
        latest.set(point.nodeId, point);
      }
    }
    return Array.from(latest.values()).sort((a, b) =>
      a.nodeId.localeCompare(b.nodeId),
    );
  }

  async observationCount() {
    return BigInt((await this.observations()).length);
  }

  private async observations() {
    await this.reloadIfChanged();
    return this.cache ?? [];
  }

  private path() {
    const base =
      this.config.get<string>(
        "RESOURCE_STORAGE_BASE_PATH",
        "/srv/resource-portal/storage",
      ) ?? "/srv/resource-portal/storage";
    return (
      this.config.get<string>(
        "CAPACITY_TELEMETRY_PATH",
        join(base, "platform", "capacity-manager-v1.jsonl"),
      ) ?? join(base, "platform", "capacity-manager-v1.jsonl")
    );
  }

  private async reloadIfChanged(force = false) {
    const path = this.path();
    const metadata = await stat(path).catch(() => null);
    if (!force && this.cache && (metadata?.mtimeMs ?? 0) <= this.lastKnownMtimeMs) {
      return;
    }
    if (!metadata) {
      this.cache = [];
      this.lastKnownMtimeMs = 0;
      return;
    }
    const raw = await readFile(path, "utf8");
    const decoded: MemoryObservation[] = [];
    for (const line of raw.split("\n")) {
      const value = line.trim();
      if (!value) continue;
      try {
        const parsed: unknown = JSON.parse(value);
        const point = this.decode(parsed);
        if (point) decoded.push(point);
      } catch {
        // A crash may leave only the final JSONL line incomplete. Ignore it.
      }
    }
    this.cache = decoded;
    this.lastKnownMtimeMs = metadata.mtimeMs;
  }

  private async compact(policy: CapacityPolicy) {
    await this.reloadIfChanged(true);
    const compacted = compactMemoryObservations(
      this.cache ?? [],
      Date.now(),
      policy,
    );
    const path = this.path();
    const temporary = path + ".tmp-" + process.pid;
    const body = compacted.length
      ? compacted.map((point) => JSON.stringify(this.encode(point))).join("\n") + "\n"
      : "";
    await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
    this.cache = compacted;
    this.lastCompactedAt = Date.now();
    this.lastKnownMtimeMs = (await stat(path)).mtimeMs;
  }

  private normalize(point: MemoryObservation): MemoryObservation {
    const observedAtMs = Date.parse(point.observedAt);
    const startedAtMs = point.containerStartedAt
      ? Date.parse(point.containerStartedAt)
      : Number.NaN;
    const startupPeak =
      Number.isFinite(observedAtMs) &&
      Number.isFinite(startedAtMs) &&
      observedAtMs >= startedAtMs &&
      observedAtMs - startedAtMs <= 10 * 60_000
        ? point.memoryPeakBytes
        : (point.startupPeakBytes ?? 0n);
    return {
      ...point,
      startupPeakBytes:
        startupPeak > (point.startupPeakBytes ?? 0n)
          ? startupPeak
          : point.startupPeakBytes,
    };
  }

  private encode(point: MemoryObservation): StoredObservation {
    return {
      ...point,
      memoryCurrentBytes: point.memoryCurrentBytes.toString(),
      memoryPeakBytes: point.memoryPeakBytes.toString(),
      startupPeakBytes: point.startupPeakBytes?.toString(),
      oomEvents: point.oomEvents.toString(),
      nodeMemoryAvailableBytes: point.nodeMemoryAvailableBytes?.toString(),
      nodeMemoryTotalBytes: point.nodeMemoryTotalBytes?.toString(),
    };
  }

  private decode(value: unknown): MemoryObservation | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const point = value as Partial<StoredObservation>;
    if (
      typeof point.observedAt !== "string" ||
      !Number.isFinite(Date.parse(point.observedAt)) ||
      typeof point.nodeId !== "string" ||
      typeof point.memoryCurrentBytes !== "string" ||
      !/^\d+$/.test(point.memoryCurrentBytes) ||
      typeof point.memoryPeakBytes !== "string" ||
      !/^\d+$/.test(point.memoryPeakBytes) ||
      typeof point.oomEvents !== "string" ||
      !/^\d+$/.test(point.oomEvents) ||
      ![30, 300, 3600].includes(Number(point.bucketSeconds))
    ) {
      return null;
    }
    const optionalBigInt = (raw: unknown) =>
      typeof raw === "string" && /^\d+$/.test(raw) ? BigInt(raw) : undefined;
    return {
      observedAt: point.observedAt,
      nodeId: point.nodeId,
      appId: typeof point.appId === "string" ? point.appId : undefined,
      containerId:
        typeof point.containerId === "string" ? point.containerId : undefined,
      containerStartedAt:
        typeof point.containerStartedAt === "string"
          ? point.containerStartedAt
          : undefined,
      memoryCurrentBytes: BigInt(point.memoryCurrentBytes),
      memoryPeakBytes: BigInt(point.memoryPeakBytes),
      startupPeakBytes: optionalBigInt(point.startupPeakBytes),
      oomEvents: BigInt(point.oomEvents),
      memoryPsiSomeAvg10:
        typeof point.memoryPsiSomeAvg10 === "number"
          ? point.memoryPsiSomeAvg10
          : undefined,
      memoryPsiFullAvg10:
        typeof point.memoryPsiFullAvg10 === "number"
          ? point.memoryPsiFullAvg10
          : undefined,
      nodeMemoryAvailableBytes: optionalBigInt(point.nodeMemoryAvailableBytes),
      nodeMemoryTotalBytes: optionalBigInt(point.nodeMemoryTotalBytes),
      bucketSeconds: Number(point.bucketSeconds) as 30 | 300 | 3600,
    };
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async withLock<T>(task: () => Promise<T>): Promise<T> {
    const lockPath = this.path() + ".lock";
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const handle = await open(lockPath, "wx", 0o600);
        try {
          await handle.writeFile(
            JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
          );
          return await task();
        } finally {
          await handle.close();
          await unlink(lockPath).catch(() => undefined);
        }
      } catch (error) {
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? String((error as { code?: unknown }).code)
            : "";
        if (code !== "EEXIST") throw error;
        const lock = await stat(lockPath).catch(() => null);
        if (lock && Date.now() - lock.mtimeMs > STALE_LOCK_MS) {
          await unlink(lockPath).catch(() => undefined);
          continue;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    throw new Error("capacity telemetry store is locked");
  }
}