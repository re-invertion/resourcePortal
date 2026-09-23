import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyRequest } from "fastify";
import { TenantMcpProtocolService } from "./tenant-mcp-protocol.service";

const tenantId = "22222222-2222-4222-8222-222222222222";
const actor = {
  id: "33333333-3333-4333-8333-333333333333",
  email: "user@example.com",
  displayName: "User",
  status: "Active" as const,
};

function fixture() {
  const config = {
    get: vi.fn((key: string, fallback?: unknown) => {
      if (key === "PORT") return 3000;
      if (key === "AUTH_MODE") return "oidc";
      if (key === "ZITADEL_PROJECT_ID") return "project-id";
      if (key === "ZITADEL_ORGANIZATION_ID") return "org-id";
      return fallback;
    }),
  };
  const settings = {
    recordToolCall: vi.fn().mockResolvedValue(undefined),
  };
  return {
    service: new TenantMcpProtocolService(config as never, settings as never),
    settings,
  };
}

function mcpRequest(headers: Record<string, string> = {}) {
  return {
    headers,
    protocol: "https",
    url: `/api/tenants/${tenantId}/mcp`,
  } as unknown as FastifyRequest;
}

async function connectClient(input: {
  service: TenantMcpProtocolService;
  request: FastifyRequest;
  authenticated?: boolean;
  legacy?: boolean;
  apiFetch?: (request: Request) => Promise<Response>;
}) {
  const [{ Client, StreamableHTTPClientTransport }, handler] = await Promise.all([
    import("@modelcontextprotocol/client"),
    input.service.createHttpHandler({
      tenantId,
      request: input.request,
      actor: input.authenticated ? actor : undefined,
      hasInteractiveCredential: input.authenticated === true,
    }),
  ]);

  const rawResponses: string[] = [];
  const fetchImpl = vi.fn(async (requestInfo: string | URL | Request, init?: RequestInit) => {
    const request =
      requestInfo instanceof Request
        ? requestInfo
        : new Request(requestInfo, init);
    if (request.url.startsWith("https://rp.example.test/")) {
      const response = await handler.fetch(request);
      rawResponses.push(await response.clone().text());
      return response;
    }
    if (input.apiFetch) return input.apiFetch(request);
    throw new Error(`Unexpected fetch: ${request.method} ${request.url}`);
  });

  const transport = new StreamableHTTPClientTransport(
    new URL("https://rp.example.test/api/tenants/" + tenantId + "/mcp"),
    { fetch: fetchImpl },
  );
  const client = new Client(
    { name: "resourceportal-mcp-test", version: "1.0.0" },
    input.legacy
      ? { versionNegotiation: { mode: "legacy" } as never }
      : undefined,
  );
  if (input.legacy) {
    await client.connect(transport, { prior: { kind: "legacy" } });
  } else {
    await client.connect(transport);
  }

  return {
    client,
    handler,
    fetchImpl,
    rawResponses,
    async close() {
      await client.close();
      await handler.close();
    },
  };
}

describe("TenantMcpProtocolService", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the official MCP v2 transport and exposes OpenAI auth metadata on focused tools", async () => {
    const { service } = fixture();
    const connection = await connectClient({
      service,
      request: mcpRequest(),
    });

    try {
      const result = await connection.client.listTools();
      const profile = result.tools.find(
        (tool) => tool.name === "resourceportal_profile",
);
      const listAppGroups = result.tools.find(
        (tool) => tool.name === "resourceportal_list_app_groups",
      );

      expect(profile).toBeTruthy();
      const expectedSecuritySchemes = [
        {
          type: "oauth2",
          scopes: [
            "openid",
            "profile",
            "email",
            "offline_access",
            "urn:zitadel:iam:org:project:id:project-id:aud",
            "urn:zitadel:iam:org:id:org-id",
          ],
        },
      ];
      expect(profile._meta?.securitySchemes).toEqual(expectedSecuritySchemes);
      expect(connection.rawResponses.join("\n")).toContain(
        JSON.stringify(expectedSecuritySchemes),
      );
      expect(connection.rawResponses.join("\n")).toContain(
        '"securitySchemes"',
      );
      expect(profile._meta?.["openai/profile"]).toBe(true);
      expect(profile.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(listAppGroups?.annotations?.readOnlyHint).toBe(true);
      expect(result.tools.some((tool) => tool.name === "resourceportal_stop_app_group")).toBe(true);
      expect(result.tools.some((tool) => tool.name === "resourceportal_tenant_api")).toBe(true);
    } finally {
      await connection.close();
    }
  });

  it("keeps 2025-era clients working through the SDK legacy stateless path", async () => {
    const { service } = fixture();
    const connection = await connectClient({
      service,
      request: mcpRequest(),
      legacy: true,
    });

    try {
      const result = await connection.client.listTools();
      expect(result.tools.some((tool) => tool.name === "resourceportal_profile")).toBe(true);
      expect(result.tools.some((tool) => tool.name === "resourceportal_list_volumes")).toBe(true);
    } finally {
      await connection.close();
    }
  });

  it("returns the standard MCP OAuth challenge when a protected tool is called before account linking", async () => {
    const { service } = fixture();
    const connection = await connectClient({
      service,
      request: mcpRequest({
        host: "resource-portal.pl",
        "x-forwarded-proto": "https",
      }),
    });

    try {
      await connection.client.listTools();
      const result = await connection.client.callTool({
        name: "resourceportal_profile",
        arguments: {},
      });

      expect(result.isError).toBe(true);
      expect(result._meta?.["mcp/www_authenticate"]).toEqual([
        expect.stringContaining(
          'resource_metadata="https://resource-portal.pl/.well-known/oauth-protected-resource/api/tenants/' +
            tenantId +
            '/mcp"',
        ),
      ]);
    } finally {
      await connection.close();
    }
  });

  it("forwards the connected OAuth token to focused tenant API tools and audits the call", async () => {
    const { service, settings } = fixture();
    const request = mcpRequest({
      authorization: "Bearer user-token",
      "x-request-id": "req-1",
      "x-correlation-id": "corr-1",
    });

    const apiFetch = vi.fn(
      (requestInfo: string | URL | Request, init?: RequestInit) => {
        const apiRequest =
          requestInfo instanceof Request
            ? requestInfo
            : new Request(requestInfo, init);
        expect(apiRequest.url).toBe(
          "http://127.0.0.1:3000/api/tenants/" + tenantId + "/app-groups",
        );
        expect(apiRequest.headers.get("authorization")).toBe("Bearer user-token");
        expect(apiRequest.headers.get("x-request-id")).toBe("req-1");
        expect(apiRequest.headers.get("x-correlation-id")).toBe("corr-1");
        return new Response(JSON.stringify([{ id: "ag1" }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
    vi.stubGlobal("fetch", apiFetch);

    const connection = await connectClient({
      service,
      request,
      authenticated: true,
    });

    try {
      await connection.client.listTools();
      const result = await connection.client.callTool({
        name: "resourceportal_list_app_groups",
        arguments: {},
      });

      expect(result.structuredContent).toEqual({
        status: 200,
        ok: true,
        data: [{ id: "ag1" }],
      });
      expect(settings.recordToolCall).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId,
          toolName: "resourceportal_list_app_groups",
          method: "GET",
          path: "/app-groups",
          success: true,
        }),
      );
    } finally {
      await connection.close();
    }
  });

  it("keeps the generic tenant API compatibility tool inside the tenant boundary", async () => {
    const { service } = fixture();
    const connection = await connectClient({
      service,
      request: mcpRequest({ authorization: "Bearer user-token" }),
      authenticated: true,
    });

    try {
      await connection.client.listTools();
      await expect(
        connection.client.callTool({
          name: "resourceportal_tenant_api",
          arguments: {
            method: "GET",
            path: "/../platform/maintenance",
          },
        }),
      ).rejects.toThrow("path escapes the tenant API boundary");
    } finally {
      await connection.close();
    }
  });
});
