import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const implementationUrl = new URL("./operation-retry.ts", import.meta.url);
const modulePath = `./${["operation", "retry"].join("-")}`;

type RetryModule = {
  computeRetryDelayMs: (attempt: number) => number;
  isRetryableOperationError: (error: unknown) => boolean;
};

async function loadRetryModule() {
  const imported = (await import(modulePath)) as unknown;
  return imported as RetryModule;
}

describe("Stage 16 operation retry policy", () => {
  it("uses bounded exponential backoff", async () => {
    expect(existsSync(fileURLToPath(implementationUrl))).toBe(true);

    const { computeRetryDelayMs } = await loadRetryModule();

    expect(computeRetryDelayMs(1)).toBe(5_000);
    expect(computeRetryDelayMs(2)).toBe(10_000);
    expect(computeRetryDelayMs(3)).toBe(20_000);
    expect(computeRetryDelayMs(10)).toBe(300_000);
  });

  it("classifies stable transient infrastructure errors for retry", async () => {
    expect(existsSync(fileURLToPath(implementationUrl))).toBe(true);

    const { isRetryableOperationError } = await loadRetryModule();

    expect(isRetryableOperationError({ code: "PlatformUnavailable" })).toBe(true);
    expect(isRetryableOperationError({ code: "InsufficientCapacity" })).toBe(true);
    expect(isRetryableOperationError({ code: "VolumeInUse" })).toBe(false);
    expect(isRetryableOperationError(new Error("permanent"))).toBe(false);
  });
});
