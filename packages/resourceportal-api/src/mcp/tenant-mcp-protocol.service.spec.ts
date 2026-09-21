import { describe, expect, it, vi, afterEach } from "vitest";
import { TenantMcpProtocolService } from "./tenant-mcp-protocol.service";

function fixture() {
  const config = {
    get: vi.fn((key: string, fallback?: unknown) => {
      if (key === "PORT") return 3000;
      if (key === "AUTH_MODE") return "oidc";
      return fallback;
    }),
  };
  const settings = { recordToolCall: vi.fn().mockResolvedValue(undefined) };
  return {
    service: new TenantMcpProtocolService(config as never, settings as never),
    settings,
  };
}

const actor = { id: "user-id", email: "user@example.com", displayName: "User", status: "Active" as const };
function request(headers: Record<string, string> = {}) {
  return { headers } as never;
}

describe("TenantMcpProtocolService", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("advertises only tenant-scoped tools", async () => {
    const { service } = fixture();
    const response = await service.handle({
      tenantId: "tenant-id",
      actor,
      request: request(),
    }, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [{ name: "resourceportal_tenant_endpoints" }, { name: "resourceportal_tenant_api" }] },
    });
  });

  it("requires modern MCP headers to agree with JSON-RPC", async () => {
    const { service } = fixture();
    const response = await service.handle({
      tenantId: "tenant-id",
      actor,
      request: request({ "mcp-protocol-version": "2026-07-28", "mcp-method": "ping" }),
    }, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    });
    expect(response.body).toMatchObject({
      error: { code: -32020, message: "Mcp-Method header must match the JSON-RPC method" },
    });
  });


  it("serves stateless 2026-07-28 discovery with the required response metadata", async () => {
    const { service } = fixture();
    const response = await service.handle({
      tenantId: "tenant-id",
      actor,
      request: request({
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "server/discover",
      }),
    }, {
      jsonrpc: "2.0",
      id: 7,
      method: "server/discover",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "1.0.0" },
        },
      },
    });

    expect(response.body).toMatchObject({
      jsonrpc: "2.0",
      id: 7,
      result: {
        supportedVersions: ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"],
        capabilities: { tools: {} },
        resultType: "complete",
        _meta: {
          "io.modelcontextprotocol/serverInfo": {
            name: "resourceportal-tenant-mcp",
            version: "0.2.4",
          },
        },
      },
    });
  });

  it("negotiates a supported legacy initialize version and falls back for unknown versions", async () => {
    const { service } = fixture();
    const supported = await service.handle({
      tenantId: "tenant-id",
      actor,
      request: request(),
    }, {
      jsonrpc: "2.0",
      id: 8,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "legacy", version: "1" } },
    });
    expect(supported.body).toMatchObject({ result: { protocolVersion: "2025-06-18" } });

    const fallback = await service.handle({
      tenantId: "tenant-id",
      actor,
      request: request(),
    }, {
      jsonrpc: "2.0",
      id: 9,
      method: "initialize",
      params: { protocolVersion: "2099-01-01", capabilities: {}, clientInfo: { name: "legacy", version: "1" } },
    });
    expect(fallback.body).toMatchObject({ result: { protocolVersion: "2025-11-25" } });
  });

  it("rejects initialize in the 2026-07-28 era", async () => {
    const { service } = fixture();
    const response = await service.handle({
      tenantId: "tenant-id",
      actor,
      request: request({
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "initialize",
      }),
    }, {
      jsonrpc: "2.0",
      id: 10,
      method: "initialize",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    });
    expect(response.body).toMatchObject({ error: { code: -32601 } });
  });

  it("rejects paths that escape the current tenant API", async () => {
    const { service } = fixture();
    const response = await service.handle({
      tenantId: "tenant-id",
      actor,
      request: request({ authorization: "Bearer token" }),
    }, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "resourceportal_tenant_api", arguments: { method: "GET", path: "/../platform/maintenance" } },
    });
    expect(response.body).toMatchObject({ error: { code: -32602, message: "path escapes the tenant API boundary" } });
  });

  it("forwards the same OAuth bearer token to the existing tenant API and audits the call", async () => {
    const { service, settings } = fixture();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([{ id: "ag1" }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await service.handle({
      tenantId: "tenant-id",
      actor,
      request: request({ authorization: "Bearer user-token", "x-request-id": "req-1", "x-correlation-id": "corr-1" }),
    }, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "resourceportal_tenant_api", arguments: { method: "GET", path: "/app-groups" } },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:3000/api/tenants/tenant-id/app-groups"),
      {
        method: "GET",
        headers: {
          accept: "application/json, text/plain;q=0.8",
          authorization: "Bearer user-token",
          "x-request-id": "req-1",
          "x-correlation-id": "corr-1",
        },
        body: undefined,
      },
    );
    expect(response.body).toMatchObject({ result: { structuredContent: { status: 200, ok: true, data: [{ id: "ag1" }] } } });
    expect(settings.recordToolCall).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "tenant-id", toolName: "resourceportal_tenant_api", success: true }));
  });
});
