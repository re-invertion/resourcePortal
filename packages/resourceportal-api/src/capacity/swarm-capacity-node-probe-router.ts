import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import type {
  CapacityNodeContainerProbe,
  CapacityNodeProbeReport,
} from "./capacity-node-probe";

export type ObservedCapacityNodeProbe = Extract<
  CapacityNodeProbeReport,
  { status: "Observed" }
>;

const NODE_ID = /^[a-z0-9]{20,64}$/;
const CONTAINER_ID = /^[a-f0-9]{12,64}$/;
const APP_ID = /^[a-zA-Z0-9._:-]{1,160}$/;
const DECIMAL = /^\d+$/;

function validContainer(value: unknown): value is CapacityNodeContainerProbe {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    CONTAINER_ID.test(item.id) &&
    typeof item.appId === "string" &&
    APP_ID.test(item.appId) &&
    (item.startedAt === undefined ||
      (typeof item.startedAt === "string" &&
        Number.isFinite(Date.parse(item.startedAt)))) &&
    typeof item.memoryCurrentBytes === "string" &&
    DECIMAL.test(item.memoryCurrentBytes) &&
    typeof item.memoryPeakBytes === "string" &&
    DECIMAL.test(item.memoryPeakBytes) &&
    typeof item.oomEvents === "string" &&
    DECIMAL.test(item.oomEvents) &&
    (item.memoryPsiSomeAvg10 === undefined ||
      (typeof item.memoryPsiSomeAvg10 === "number" &&
        Number.isFinite(item.memoryPsiSomeAvg10) &&
        item.memoryPsiSomeAvg10 >= 0)) &&
    (item.memoryPsiFullAvg10 === undefined ||
      (typeof item.memoryPsiFullAvg10 === "number" &&
        Number.isFinite(item.memoryPsiFullAvg10) &&
        item.memoryPsiFullAvg10 >= 0))
  );
}

function validReport(value: unknown): value is ObservedCapacityNodeProbe {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (
    item.status !== "Observed" ||
    typeof item.swarmNodeId !== "string" ||
    !NODE_ID.test(item.swarmNodeId) ||
    typeof item.memoryTotalBytes !== "string" ||
    !DECIMAL.test(item.memoryTotalBytes) ||
    typeof item.memoryAvailableBytes !== "string" ||
    !DECIMAL.test(item.memoryAvailableBytes) ||
    typeof item.memoryPsiSomeAvg10 !== "number" ||
    !Number.isFinite(item.memoryPsiSomeAvg10) ||
    item.memoryPsiSomeAvg10 < 0 ||
    typeof item.memoryPsiFullAvg10 !== "number" ||
    !Number.isFinite(item.memoryPsiFullAvg10) ||
    item.memoryPsiFullAvg10 < 0 ||
    !Array.isArray(item.containers) ||
    item.containers.length > 512 ||
    !item.containers.every(validContainer)
  ) {
    return false;
  }
  const total = BigInt(item.memoryTotalBytes);
  const available = BigInt(item.memoryAvailableBytes);
  return total > 0n && available <= total;
}

@Injectable()
export class SwarmCapacityNodeProbeRouter {
  constructor(private readonly config: ConfigService) {}

  async collect(): Promise<ObservedCapacityNodeProbe[]> {
    const file = this.config.get<string>("INTERNAL_WORKER_TOKEN_FILE");
    let token = this.config.get<string>("INTERNAL_WORKER_TOKEN") ?? "";
    if (file) {
      try {
        token = readFileSync(file, "utf8").trim();
      } catch {
        return [];
      }
    }
    if (token.length < 16) return [];

    const stack =
      this.config.get<string>("RESOURCEPORTAL_CONTROL_PLANE_STACK_NAME") ??
      "resourceportal-control-plane";
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(stack)) return [];

    const addresses = await lookup("tasks." + stack + "_terminal-agent", {
      all: true,
      family: 4,
    }).catch(() => []);
    const unique = [...new Set(addresses.map((item) => item.address))];
    if (unique.length > 128) return [];

    const reports = await Promise.allSettled(
      unique.map(async (address) => {
        if (!/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(address)) return null;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12_000);
        try {
          const response = await fetch(
            "http://" + address + ":3102/internal/capacity-probe",
            {
              method: "POST",
              headers: {
                "x-internal-token": token,
                "content-type": "application/json",
              },
              body: "{}",
              signal: controller.signal,
            },
          );
          if (!response.ok) return null;
          const raw: unknown = await response.json();
          return validReport(raw) ? raw : null;
        } finally {
          clearTimeout(timeout);
        }
      }),
    );

    const trusted = reports.flatMap((item) =>
      item.status === "fulfilled" && item.value !== null ? [item.value] : [],
    );
    const nodeCounts = new Map<string, number>();
    for (const report of trusted) {
      nodeCounts.set(
        report.swarmNodeId,
        (nodeCounts.get(report.swarmNodeId) ?? 0) + 1,
      );
    }
    return trusted.filter(
      (item) => nodeCounts.get(item.swarmNodeId) === 1,
    );
  }
}
