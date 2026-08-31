import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { OperationRecord } from "../operation.types";

const implementationUrl = new URL("./domain-operation.executors.ts", import.meta.url);
const modulePath = "./domain-operation.executors";

describe("Stage 16 domain operation executor", () => {
  it("delegates DOMAIN_VERIFY to existing domain validation", async () => {
    expect(existsSync(fileURLToPath(implementationUrl))).toBe(true);
    const imported = (await import(modulePath)) as unknown as {
      DomainOperationExecutor: new (domains: unknown) => {
        execute: (operation: OperationRecord) => Promise<{ result?: unknown }>;
      };
    };
    const validateDomain = vi.fn().mockResolvedValue({ id: "33333333-3333-4333-8333-333333333333", dnsStatus: "Valid" });
    const executor = new imported.DomainOperationExecutor({ validateDomain });
    const operation = {
      id: "11111111-1111-4111-8111-111111111111",
      type: "DOMAIN_VERIFY",
      tenantId: "22222222-2222-4222-8222-222222222222",
      resourceType: "Domain",
      resourceId: "33333333-3333-4333-8333-333333333333",
      createdBy: "44444444-4444-4444-8444-444444444444",
      createdByEmail: "actor@example.com",
      createdByDisplayName: "Actor",
      input: {},
    } as OperationRecord;

    const result = await executor.execute(operation);

    expect(validateDomain).toHaveBeenCalledWith(
      operation.tenantId,
      operation.resourceId,
      expect.objectContaining({ id: operation.createdBy }),
    );
    expect(result.result).toEqual(expect.objectContaining({ dnsStatus: "Valid" }));
  });
});
