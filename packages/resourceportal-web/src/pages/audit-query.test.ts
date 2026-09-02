import { describe, expect, it } from "vitest";
import { buildAuditQueries, formatAuditExport } from "./audit-query";

describe("audit query mapping", () => {
  it("keeps pagination on list requests and removes it from exports", () => {
    expect(buildAuditQueries({
      action: "quota.update",
      actor: "user-1",
      resourceType: "Quota",
      cursor: "8ef33209-dff9-4a9e-a0d7-2cc09d09f5e6",
      limit: 10,
      format: "csv",
      unsupported: "ignored",
    })).toEqual({
      list: "?action=quota.update&actor=user-1&resourceType=Quota&cursor=8ef33209-dff9-4a9e-a0d7-2cc09d09f5e6&limit=10",
      export: "?action=quota.update&actor=user-1&resourceType=Quota&format=csv",
    });
  });

  it("serializes JSON export payloads for display", () => {
    expect(formatAuditExport([{ action: "quota.update" }])).toBe('[\n  {\n    "action": "quota.update"\n  }\n]');
    expect(formatAuditExport("a,b\n1,2")).toBe("a,b\n1,2");
  });
});
