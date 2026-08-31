import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const implementationUrl = new URL("./operations.controller.ts", import.meta.url);
const modulePath = `./${["operations"].join("-")}.controller`;

describe("Stage 16 OperationsController", () => {
  it("exposes tenant-scoped list, events and manual retry", async () => {
    expect(existsSync(fileURLToPath(implementationUrl))).toBe(true);
    const imported = (await import(modulePath)) as unknown as {
      OperationsController: new (service: unknown) => {
        listOperations: (tenantId: string) => Promise<unknown>;
        listEvents: (tenantId: string, operationId: string) => Promise<unknown>;
        retryOperation: (tenantId: string, operationId: string) => Promise<unknown>;
      };
    };
    const list = vi.fn().mockResolvedValue([]);
    const events = vi.fn().mockResolvedValue([]);
    const retry = vi.fn().mockResolvedValue({ id: "op-1", status: "Pending" });
    const controller = new imported.OperationsController({ list, events, retry });

    await controller.listOperations("tenant-1");
    await controller.listEvents("tenant-1", "op-1");
    await controller.retryOperation("tenant-1", "op-1");

    expect(list).toHaveBeenCalledWith("tenant-1");
    expect(events).toHaveBeenCalledWith("tenant-1", "op-1");
    expect(retry).toHaveBeenCalledWith("tenant-1", "op-1");
  });
});
