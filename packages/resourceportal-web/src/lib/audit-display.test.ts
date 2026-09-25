import { describe, expect, it } from "vitest";
import { auditActionDetail, auditActionLabel, auditResourceLabel } from "./audit-display";

describe("MCP audit display", () => {
  it("renders MCP tool audit records with useful request details", () => {
    const row = {
      action: "tenant.mcp.tool.call",
      resourceType: "TenantMcp",
      changes: {
        toolName: "resourceportal_list_app_groups",
        method: "GET",
        path: "/app-groups",
        statusCode: 200,
      },
    };

    expect(auditActionLabel(row)).toBe("MCP tool call");
    expect(auditResourceLabel(row)).toBe("MCP");
    expect(auditActionDetail(row)).toBe("resourceportal_list_app_groups · GET /app-groups · HTTP 200");
  });

  it("renders MCP settings changes with a readable label", () => {
    expect(auditActionLabel({ action: "tenant.mcp.settings.update" })).toBe("MCP settings updated");
  });
});
