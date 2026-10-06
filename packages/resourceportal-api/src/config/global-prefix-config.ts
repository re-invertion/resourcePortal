import { RequestMethod, RouteInfo } from "@nestjs/common";

export const globalPrefixExcludes: RouteInfo[] = [
  {
    path: ".well-known/oauth-protected-resource/api/tenants/:mcpTenantId/mcp",
    method: RequestMethod.GET,
  },
  {
    path: ".well-known/oauth-protected-resource/api/platform/mcp",
    method: RequestMethod.GET,
  },
  {
    path: ".well-known/oauth-authorization-server",
    method: RequestMethod.GET,
  },
  {
    path: "oauth/v2/register",
    method: RequestMethod.POST,
  },
];
