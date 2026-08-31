import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const implementationUrl = new URL("./operation-event-bus.ts", import.meta.url);
const modulePath = "./operation-event-bus";

describe("Stage 16 OperationEventBus", () => {
  it("publishes lifecycle events to all subscribers without making a failing subscriber authoritative", async () => {
    expect(existsSync(fileURLToPath(implementationUrl))).toBe(true);
    const imported = (await import(modulePath)) as unknown as {
      OperationEventBus: new () => {
        subscribe: (handler: (event: unknown) => unknown) => () => void;
        publish: (event: unknown) => Promise<void>;
      };
    };
    const bus = new imported.OperationEventBus();
    const first = vi.fn().mockRejectedValue(new Error("consumer failed"));
    const second = vi.fn().mockResolvedValue(undefined);
    const unsubscribe = bus.subscribe(first);
    bus.subscribe(second);
    const event = {
      operationId: "11111111-1111-4111-8111-111111111111",
      type: "VOLUME_CREATE",
      status: "Running",
      event: "ExecutionStarted",
    };

    await expect(bus.publish(event)).resolves.toBeUndefined();
    expect(first).toHaveBeenCalledWith(event);
    expect(second).toHaveBeenCalledWith(event);

    unsubscribe();
    await bus.publish({ ...event, event: "ExecutionSucceeded" });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });
});
