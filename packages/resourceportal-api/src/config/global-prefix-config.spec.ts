import { RequestMethod } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { globalPrefixExcludes } from "./global-prefix-config";

describe("globalPrefixExcludes", () => {
  it("keeps both MCP protected-resource metadata routes outside the /api prefix", () => {
    expect(globalPrefixExcludes).toContainEqual({
      path: ".well-known/oauth-protected-resource/api/tenants/:mcpTenantId/mcp",
      method: RequestMethod.GET,
    });
    expect(globalPrefixExcludes).toContainEqual({
      path: ".well-known/oauth-protected-resource/api/platform/mcp",
      method: RequestMethod.GET,
    });
  });
});
