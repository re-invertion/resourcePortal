import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import type { NvidiaGpuObservation } from "./nvidia-gpu-observation";
import type { SwarmGpuNodeUsage } from "./nvidia-gpu-node-probe";

export type NodeGpuProbeReport =
  | { swarmNodeId: string; status: "Observed"; devices: NvidiaGpuObservation[] }
  | { swarmNodeId: string; status: "Unavailable"; devices: readonly []; reason: string };

function validObservation(value: unknown): value is NvidiaGpuObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.uuid === "string" &&
    /^GPU-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(item.uuid) &&
    item.vendor === "NVIDIA" &&
    typeof item.model === "string" && item.model.length >= 1 && item.model.length <= 256 &&
    typeof item.pciBusId === "string" &&
    typeof item.driverVersion === "string" &&
    typeof item.memoryBytes === "string" && /^[1-9][0-9]*$/.test(item.memoryBytes) &&
    (item.memoryUsedBytes === null ||
      typeof item.memoryUsedBytes === "string" && /^[0-9]+$/.test(item.memoryUsedBytes)) &&
    (item.temperatureCelsius === null ||
      Number.isInteger(item.temperatureCelsius) &&
      Number(item.temperatureCelsius) <= 150 && Number(item.temperatureCelsius) >= 0) &&
    (item.utilizationPercent === null ||
      Number.isInteger(item.utilizationPercent) &&
      Number(item.utilizationPercent) <= 100 && Number(item.utilizationPercent) >= 0);
}

/**
 * A private Swarm DNS enumeration, not a public GPU inspection endpoint.
 * Reports are accepted only from existing agent services authenticated by the
 * internal Worker secret, and cross-checked against known Swarm node IDs.
 */
@Injectable()
export class SwarmGpuNodeProbeRouter {
  constructor(private readonly config: ConfigService) {}

  async collect(): Promise<NodeGpuProbeReport[]> {
    const file = this.config.get<string>("INTERNAL_WORKER_TOKEN_FILE");
    let token = this.config.get<string>("INTERNAL_WORKER_TOKEN") ?? "";
    if (file) {
      try { token = readFileSync(file, "utf8").trim(); }
      catch { return []; }
    }
    if (token.length < 16) return [];
    const stack = this.config.get<string>("RESOURCEPORTAL_CONTROL_PLANE_STACK_NAME")
      ?? "resourceportal-control-plane";
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(stack)) return [];
    const addresses = await lookup("tasks." + stack + "_terminal-agent", {
      all: true, family: 4,
    }).catch(() => []);
    const unique = [...new Set(addresses.map((item) => item.address))];
    if (unique.length > 128) return [];
    const reports = await Promise.allSettled(unique.map(async (address) => {
      if (!/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(address)) return null;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20_000);
      try {
        const response = await fetch("http://" + address + ":3102/internal/gpu-probe", {
          method: "POST",
          headers: { "x-internal-token": token, "content-type": "application/json" },
          body: "{}",
          signal: controller.signal,
        });
        if (!response.ok) return null;
        const raw: unknown = await response.json();
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
        const item = raw as Record<string, unknown>;
        if (typeof item.swarmNodeId !== "string" ||
            !/^[a-z0-9]{20,40}$/.test(item.swarmNodeId)) return null;
        if (item.status === "Unavailable") {
          return { swarmNodeId: item.swarmNodeId, status: "Unavailable", devices: [],
            reason: typeof item.reason === "string" && /^[A-Za-z][A-Za-z0-9]{2,79}$/.test(item.reason)
              ? item.reason : "GpuProbeUnavailable" } as const;
        }
        if (item.status !== "Observed" || !Array.isArray(item.devices) ||
            !item.devices.length || item.devices.length > 128 ||
            !item.devices.every(validObservation)) return null;
        const devices = item.devices;
        if (new Set(devices.map((gpu) => gpu.uuid.toLowerCase())).size !== devices.length) return null;
        return { swarmNodeId: item.swarmNodeId, status: "Observed", devices } as const;
      } finally { clearTimeout(timeout); }
    }));
    const trusted = reports.flatMap((item) =>
      item.status === "fulfilled" && item.value !== null ? [item.value] : []);
    const nodeCounts = new Map<string, number>();
    for (const report of trusted) {
      nodeCounts.set(report.swarmNodeId, (nodeCounts.get(report.swarmNodeId) ?? 0) + 1);
    }
    return trusted.filter((item) => nodeCounts.get(item.swarmNodeId) === 1);
  }

  /** Fresh authenticated node-local container census. An absent or duplicate
   * report is not proof of absence and must block any GPU release. */
  async collectUsage(): Promise<SwarmGpuNodeUsage[]> {
    const file = this.config.get<string>("INTERNAL_WORKER_TOKEN_FILE");
    let token = this.config.get<string>("INTERNAL_WORKER_TOKEN") ?? "";
    if (file) {
      try { token = readFileSync(file, "utf8").trim(); }
      catch { return []; }
    }
    if (token.length < 16) return [];
    const stack = this.config.get<string>("RESOURCEPORTAL_CONTROL_PLANE_STACK_NAME")
      ?? "resourceportal-control-plane";
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(stack)) return [];
    const addresses = await lookup("tasks." + stack + "_terminal-agent", {
      all: true, family: 4,
    }).catch(() => []);
    const unique = [...new Set(addresses.map((item) => item.address))];
    if (!unique.length || unique.length > 128) return [];
    const responses = await Promise.allSettled(unique.map(async (address): Promise<SwarmGpuNodeUsage | null> => {
      if (!/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(address)) return null;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12_000);
      try {
        const response = await fetch("http://" + address + ":3102/internal/gpu-usage", {
          method: "POST",
          headers: { "x-internal-token": token, "content-type": "application/json" },
          body: "{}",
          signal: controller.signal,
        });
        if (!response.ok) return null;
        const raw: unknown = await response.json();
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
        const item = raw as Record<string, unknown>;
        if (typeof item.swarmNodeId !== "string" ||
            !/^[a-z0-9]{20,40}$/.test(item.swarmNodeId)) return null;
        if (item.status === "Unavailable") {
          return { swarmNodeId: item.swarmNodeId, status: "Unavailable",
            reason: typeof item.reason === "string" &&
              /^[A-Za-z][A-Za-z0-9]{2,79}$/.test(item.reason)
              ? item.reason : "GpuContainerInventoryUnavailable" };
        }
        if (item.status !== "Verified" || typeof item.busyAnyGpu !== "boolean" ||
            !Array.isArray(item.containers) || item.containers.length > 256) return null;
        const containers: Array<{ serviceName: string | null; uuid: string }> = [];
        for (const entry of item.containers) {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
          const data = entry as Record<string, unknown>;
          if (typeof data.uuid !== "string" ||
              !/^GPU-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(data.uuid) ||
              !(data.serviceName === null ||
                typeof data.serviceName === "string" && /^[a-zA-Z0-9_-]{1,180}$/.test(data.serviceName))) return null;
          containers.push({ uuid: data.uuid, serviceName: data.serviceName });
        }
        return { swarmNodeId: item.swarmNodeId, status: "Verified",
          busyAnyGpu: item.busyAnyGpu, containers };
      } finally { clearTimeout(timeout); }
    }));
    const received = responses.flatMap((result) =>
      result.status === "fulfilled" && result.value ? [result.value] : []);
    const counts = new Map<string, number>();
    for (const report of received) {
      if (report.swarmNodeId) counts.set(report.swarmNodeId, (counts.get(report.swarmNodeId) ?? 0) + 1);
    }
    return received.filter((item) => item.swarmNodeId !== null &&
      counts.get(item.swarmNodeId) === 1);
  }
}
