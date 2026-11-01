import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  DEFAULT_CAPACITY_POLICY,
  type CapacityPolicy,
} from "./capacity-hybrid.logic";

const GiB = 1_073_741_824n;

@Injectable()
export class CapacityPolicyService {
  private override?: CapacityPolicy;

  constructor(private readonly config: ConfigService) {}

  current(): CapacityPolicy {
    if (this.override) return this.override;
    const mode = this.config.get<string>("CAPACITY_MODE", DEFAULT_CAPACITY_POLICY.mode) ?? "Hybrid";
    return this.normalize({
      ...DEFAULT_CAPACITY_POLICY,
      mode: mode === "Strict" ? "Strict" : "Hybrid",
      telemetryIntervalSeconds: this.number("CAPACITY_TELEMETRY_INTERVAL_SECONDS", 30),
      predictionPercentile: this.number("CAPACITY_PREDICTION_PERCENTILE", 99) === 95 ? 95 : 99,
      applicationMarginPercent: this.number("CAPACITY_APPLICATION_MARGIN_PERCENT", 15),
      nodeSafetyBufferPercent: this.number("CAPACITY_NODE_SAFETY_BUFFER_PERCENT", 20),
      maxTelemetryAgeSeconds: this.number("CAPACITY_MAX_TELEMETRY_AGE_SECONDS", 90),
      minimumSystemReserveBytes:
        BigInt(this.number("CAPACITY_MIN_SYSTEM_RESERVE_MIB", 1024)) * 1024n * 1024n,
    });
  }

  set(
    input: Partial<Omit<CapacityPolicy, "minimumSystemReserveBytes">> & {
      minimumSystemReserveBytes?: string | number | bigint;
    },
  ) {
    const current = this.current();
    this.override = this.normalize({
      ...current,
      ...input,
      minimumSystemReserveBytes:
        input.minimumSystemReserveBytes === undefined
          ? current.minimumSystemReserveBytes
          : BigInt(input.minimumSystemReserveBytes),
    });
    return this.override;
  }

  serialize(policy = this.current()) {
    return {
      ...policy,
      minimumSystemReserveBytes: policy.minimumSystemReserveBytes.toString(),
    };
  }

  private number(key: string, fallback: number) {
    const raw = this.config.get<string | number>(key, fallback);
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  }

  private normalize(input: CapacityPolicy): CapacityPolicy {
    if (!["Strict", "Hybrid"].includes(input.mode)) {
      throw new Error("capacity mode must be Strict or Hybrid");
    }
    if (
      input.telemetryIntervalSeconds < 10 ||
      input.telemetryIntervalSeconds > 300
    ) {
      throw new Error("telemetry interval must be 10..300 seconds");
    }
    if (input.exactRetentionDays < 1 || input.exactRetentionDays > 7) {
      throw new Error("exact retention must be 1..7 days");
    }
    if (
      input.predictionWindowDays < 7 ||
      input.predictionWindowDays > 30
    ) {
      throw new Error("prediction window must be 7..30 days");
    }
    if (
      input.rareEventRetentionDays < 30 ||
      input.rareEventRetentionDays > 90
    ) {
      throw new Error("rare-event retention must be 30..90 days");
    }
    if (![95, 99].includes(input.predictionPercentile)) {
      throw new Error("prediction percentile must be 95 or 99");
    }
    if (
      !Number.isInteger(input.applicationMarginPercent) ||
      input.applicationMarginPercent < 5 ||
      input.applicationMarginPercent > 50
    ) {
      throw new Error("application margin must be an integer from 5..50 percent");
    }
    if (
      !Number.isInteger(input.nodeSafetyBufferPercent) ||
      input.nodeSafetyBufferPercent < 10 ||
      input.nodeSafetyBufferPercent > 50
    ) {
      throw new Error("node safety buffer must be an integer from 10..50 percent");
    }
    if (
      input.maxTelemetryAgeSeconds < 30 ||
      input.maxTelemetryAgeSeconds > 300
    ) {
      throw new Error("telemetry max age must be 30..300 seconds");
    }
    if (
      input.minimumSystemReserveBytes < 256n * 1024n * 1024n ||
      input.minimumSystemReserveBytes > 32n * GiB
    ) {
      throw new Error(
        "minimum system reserve must be between 256 MiB and 32 GiB",
      );
    }
    return input;
  }
}
