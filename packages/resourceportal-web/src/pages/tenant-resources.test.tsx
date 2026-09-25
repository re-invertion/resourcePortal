import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TenantActivity } from "./tenant-resources";

function json(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

describe("TenantActivity MCP audit", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows MCP tool calls from the tenant audit log", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/operations")) return json([]);
      if (url.endsWith("/audit-log")) {
        return json([{
          id: "audit-1",
          action: "tenant.mcp.tool.call",
          actorName: "Alice Admin",
          resourceType: "TenantMcp",
          result: "Success",
          timestamp: "2026-09-25T07:30:00.000Z",
          changes: {
            toolName: "resourceportal_list_app_groups",
            method: "GET",
            path: "/app-groups",
            statusCode: 200,
          },
        }]);
      }
      return json([]);
    }));

    render(<TenantActivity tenantId="tenant-1" />);

    expect(await screen.findByText("MCP tool call")).toBeTruthy();
    expect(screen.getByText("resourceportal_list_app_groups · GET /app-groups · HTTP 200")).toBeTruthy();
    expect(screen.getByText("Alice Admin")).toBeTruthy();
  });
});
