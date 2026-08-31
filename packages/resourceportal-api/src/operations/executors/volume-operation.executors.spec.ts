import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { OperationRecord } from "../operation.types";

const implementationUrl = new URL("./volume-operation.executors.ts", import.meta.url);
const modulePath = `./${["volume", "operation", "executors"].join("-")}`;

const baseOperation = {
  id: "11111111-1111-4111-8111-111111111111",
  tenantId: "22222222-2222-4222-8222-222222222222",
  resourceId: null,
  createdBy: "44444444-4444-4444-8444-444444444444",
  createdByEmail: "actor@example.com",
  createdByDisplayName: "Actor",
  input: {},
} as OperationRecord;

describe("Stage 16 volume operation executor", () => {
  it("delegates VOLUME_CREATE to the existing Volume lifecycle service", async () => {
    expect(existsSync(fileURLToPath(implementationUrl))).toBe(true);
    const imported = (await import(modulePath)) as unknown as {
      VolumeOperationExecutor: new (volumes: unknown) => {
        execute: (operation: OperationRecord) => Promise<{ resourceId?: string | null }>;
      };
    };
    const createVolume = vi.fn().mockResolvedValue({ id: "55555555-5555-4555-8555-555555555555" });
    const executor = new imported.VolumeOperationExecutor({ createVolume });
    const operation = {
      ...baseOperation,
      type: "VOLUME_CREATE",
      resourceType: "Volume",
      input: { dto: { name: "data", sizeBytes: 1024 } },
    } as OperationRecord;

    const result = await executor.execute(operation);

    expect(createVolume).toHaveBeenCalledWith(
      baseOperation.tenantId,
      { name: "data", sizeBytes: 1024 },
      expect.objectContaining({ id: baseOperation.createdBy, email: baseOperation.createdByEmail }),
    );
    expect(result.resourceId).toBe("55555555-5555-4555-8555-555555555555");
  });
});
