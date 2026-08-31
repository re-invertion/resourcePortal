import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { OperationExecutionResult, OperationRecord, OperationType } from "./operation.types";

const implementationUrl = new URL(
  "./operation-executor-registry.ts",
  import.meta.url,
);
const modulePath = `./${["operation", "executor", "registry"].join("-")}`;

type Executor = {
  types: readonly OperationType[];
  execute: (operation: OperationRecord) => Promise<OperationExecutionResult>;
};

type Registry = {
  resolve: (type: OperationType) => Executor;
};

type RegistryModule = {
  OperationExecutorRegistry: new (executors: Executor[]) => Registry;
};

async function loadRegistryModule() {
  const imported = (await import(modulePath)) as unknown;
  return imported as RegistryModule;
}

describe("Stage 16 OperationExecutorRegistry", () => {
  it("resolves the executor registered for an operation type", async () => {
    expect(existsSync(fileURLToPath(implementationUrl))).toBe(true);
    const { OperationExecutorRegistry } = await loadRegistryModule();
    const execute = vi.fn().mockResolvedValue({ result: { ok: true } });
    const executor: Executor = {
      types: ["DOMAIN_VERIFY"],
      execute,
    };

    const registry = new OperationExecutorRegistry([executor]);

    expect(registry.resolve("DOMAIN_VERIFY")).toBe(executor);
  });

  it("rejects an operation type without an executor", async () => {
    expect(existsSync(fileURLToPath(implementationUrl))).toBe(true);
    const { OperationExecutorRegistry } = await loadRegistryModule();
    const registry = new OperationExecutorRegistry([]);

    expect(() => registry.resolve("VOLUME_CREATE")).toThrow(
      "UnsupportedOperationType: VOLUME_CREATE",
    );
  });
});
