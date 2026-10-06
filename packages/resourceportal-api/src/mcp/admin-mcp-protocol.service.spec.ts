import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyRequest } from "fastify";
import { AdminMcpProtocolService } from "./admin-mcp-protocol.service";

const actor = {
  id: "33333333-3333-4333-8333-333333333333",
  email: "admin@example.com",
  displayName: "Platform Admin",
  status: "Active" as const,
};

function fixture(options: { platformAdmin?: boolean } = {}) {
  const config = {
    get: vi.fn((key: string, fallback?: unknown) => {
      if (key === "PORT") return 3000;
      if (key === "AUTH_MODE") return "oidc";
      if (key === "ZITADEL_PROJECT_ID") return "project-id";
      if (key === "ZITADEL_ORGANIZATION_ID") return "org-id";
      if (key === "PLATFORM_ADMIN_USER_IDS") {
        return options.platformAdmin === false ? "" : actor.id;
      }
      if (key === "OIDC_ISSUER_URL") return "https://auth.example.test";
      return fallback;
    }),
  };
  const prisma = {
    userIdentity: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
  };
  const audit = {
    recordToolCall: vi.fn().mockResolvedValue(undefined),
  };
  return {
    service: new AdminMcpProtocolService(
      config as never,
      prisma as never,
      audit as never,
    ),
    audit,
  };
}

function mcpRequest(headers: Record<string, string> = {}) {
  return {
    headers,
    protocol: "https",
    url: "/api/platform/mcp",
  } as unknown as FastifyRequest;
}

async function connectClient(input: {
  service: AdminMcpProtocolService;
  request: FastifyRequest;
  authenticated?: boolean;
  apiFetch?: (request: Request) => Promise<Response>;
}) {
  const [{ Client, StreamableHTTPClientTransport }, handler] = await Promise.all([
    import("@modelcontextprotocol/client"),
    input.service.createHttpHandler({
      request: input.request,
      actor: input.authenticated ? actor : undefined,
      hasInteractiveCredential: input.authenticated === true,
    }),
  ]);

  const rawResponses: string[] = [];
  const fetchImpl = vi.fn(
    async (requestInfo: string | URL | Request, init?: RequestInit) => {
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
    },
  );

  const transport = new StreamableHTTPClientTransport(
    new URL("https://rp.example.test/api/platform/mcp"),
    { fetch: fetchImpl },
  );
  const client = new Client(
    { name: "resourceportal-admin-mcp-test", version: "1.0.0" },
  );
  await client.connect(transport);

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

describe("AdminMcpProtocolService", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("exposes a dedicated explicit Platform Admin tool catalog with no generic passthrough", async () => {
    const { service } = fixture();
    const connection = await connectClient({
      service,
      request: mcpRequest(),
    });

    try {
      const result = await connection.client.listTools();
      const names = result.tools.map((tool) => tool.name);

      expect(names.length).toBeGreaterThan(55);
      expect(names.every((name) => name.startsWith("resourceportal_admin_"))).toBe(
        true,
      );
      expect(names).toContain("resourceportal_admin_profile");
      expect(names).toContain("resourceportal_admin_capabilities");
      expect(names).toContain("resourceportal_admin_list_tenants");
      expect(names).toContain("resourceportal_admin_list_users");
      expect(names).toContain("resourceportal_admin_get_swarm_cluster");
      expect(names).toContain("resourceportal_admin_get_metrics");
      expect(names).toContain("resourceportal_admin_list_operations");
      expect(names).toContain("resourceportal_admin_list_audit_log");
      expect(names).toContain("resourceportal_admin_set_platform_maintenance");
      expect(names).toContain("resourceportal_admin_list_storage_backends");
      expect(names).toContain("resourceportal_admin_get_dns");
      expect(names).toContain("resourceportal_admin_get_email");
      expect(names).toContain("resourceportal_admin_get_resource_bot");
      expect(names).toContain("resourceportal_admin_list_price_lists");
      expect(names).toContain("resourceportal_admin_list_identity_providers");
      expect(names).toContain("resourceportal_admin_list_oauth_applications");
      expect(names).toContain("resourceportal_admin_list_service_identities");
      expect(names).toContain("resourceportal_admin_list_bug_reports");
      expect(names).toContain("resourceportal_admin_resolve_bug_report");
      expect(names).not.toContain("resourceportal_admin_api");
      expect(names.some((name) => name.includes("tenant_api"))).toBe(false);
      expect(names.some((name) => name.includes("shell"))).toBe(false);
      expect(names.some((name) => name.includes("sql"))).toBe(false);

      const tenants = result.tools.find(
        (tool) => tool.name === "resourceportal_admin_list_tenants",
      );
      expect(tenants?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      });

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
      expect(tenants?._meta?.securitySchemes).toEqual(expectedSecuritySchemes);
      expect(connection.rawResponses.join("\n")).toContain(
        '"resourceportal_admin_resolve_bug_report"',
      );
    } finally {
      await connection.close();
    }
  }, 60_000);

  it("returns the Admin MCP OAuth protected-resource challenge before account linking", async () => {
    const { service } = fixture();
    const connection = await connectClient({
      service,
      request: mcpRequest({
        host: "resource-portal.pl",
        "x-forwarded-proto": "https",
      }),
    });

    try {
      const result = await connection.client.callTool({
        name: "resourceportal_admin_profile",
        arguments: {},
      });

      expect(result.isError).toBe(true);
      expect(result._meta?.["mcp/www_authenticate"]).toEqual([
        expect.stringContaining(
          'resource_metadata="https://resource-portal.pl/.well-known/oauth-protected-resource/api/platform/mcp"',
        ),
      ]);
    } finally {
      await connection.close();
    }
  });

  it("keeps the tenant and user directories read-only while forwarding the admin OAuth token", async () => {
    const { service, audit } = fixture();
    const request = mcpRequest({
      authorization: "Bearer platform-admin-token",
      "x-request-id": "req-tenants",
      "x-correlation-id": "corr-tenants",
    });
    const apiFetch = vi.fn((requestInfo: string | URL | Request, init?: RequestInit) => {
      const request =
        requestInfo instanceof Request
          ? requestInfo
          : new Request(requestInfo, init);
      expect(request.url).toBe("http://127.0.0.1:3000/api/platform/tenants");
      expect(request.method).toBe("GET");
      expect(request.headers.get("authorization")).toBe(
        "Bearer platform-admin-token",
      );
      return Promise.resolve(
        new Response(JSON.stringify([{ id: "tenant-1", name: "Tenant 1" }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });
    vi.stubGlobal("fetch", apiFetch);

    const connection = await connectClient({
      service,
      request,
      authenticated: true,
    });

    try {
      const result = await connection.client.callTool({
        name: "resourceportal_admin_list_tenants",
        arguments: {},
      });
      expect(result.structuredContent).toEqual({
        status: 200,
        ok: true,
        data: [{ id: "tenant-1", name: "Tenant 1" }],
      });
      expect(audit.recordToolCall).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "resourceportal_admin_list_tenants",
          method: "GET",
          path: "/api/platform/tenants",
          success: true,
          requestId: "req-tenants",
          correlationId: "corr-tenants",
        }),
      );
    } finally {
      await connection.close();
    }
  });

  it("resolves Bug Reports through the real platform endpoint and never sends a tenant path", async () => {
    const { service, audit } = fixture();
    const reportId = "44444444-4444-4444-8444-444444444444";
    const request = mcpRequest({ authorization: "Bearer admin-token" });
    const apiFetch = vi.fn(async (requestInfo: string | URL | Request, init?: RequestInit) => {
      const request =
        requestInfo instanceof Request
          ? requestInfo
          : new Request(requestInfo, init);
      expect(request.url).toBe(
        `http://127.0.0.1:3000/api/platform/bug-reports/${reportId}/resolution`,
      );
      expect(request.url).not.toContain("/api/tenants/");
      expect(request.method).toBe("PATCH");
      expect(await request.json()).toEqual({
        resolved: true,
        resolutionNote: "Fixed in v0.2.62.",
      });
      return new Response(
        JSON.stringify({ id: reportId, resolved: true }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", apiFetch);

    const connection = await connectClient({
      service,
      request,
      authenticated: true,
    });

    try {
      const result = await connection.client.callTool({
        name: "resourceportal_admin_resolve_bug_report",
        arguments: {
          reportId,
          resolutionNote: "Fixed in v0.2.62.",
        },
      });
      expect(result.structuredContent).toEqual({
        status: 200,
        ok: true,
        data: { id: reportId, resolved: true },
      });
      expect(audit.recordToolCall).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "resourceportal_admin_resolve_bug_report",
          method: "PATCH",
          path: `/api/platform/bug-reports/${reportId}/resolution`,
          success: true,
        }),
      );
      const auditCall = audit.recordToolCall.mock.calls.at(-1)?.[0];
      expect(auditCall).not.toHaveProperty("body");
      expect(JSON.stringify(auditCall)).not.toContain("Fixed in v0.2.62.");
    } finally {
      await connection.close();
    }
  });

  it("exposes stored Bug Report images as MCP image content without arbitrary file access", async () => {
    const { service } = fixture();
    const reportId = "44444444-4444-4444-8444-444444444444";
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn((requestInfo: string | URL | Request, init?: RequestInit) => {
        const request =
          requestInfo instanceof Request
            ? requestInfo
            : new Request(requestInfo, init);
        expect(request.url).toBe(
          `http://127.0.0.1:3000/api/platform/bug-reports/${reportId}/image`,
        );
        return Promise.resolve(
          new Response(png, {
            status: 200,
            headers: { "content-type": "image/png" },
          }),
        );
      }),
    );

    const connection = await connectClient({
      service,
      request: mcpRequest({ authorization: "Bearer admin-token" }),
      authenticated: true,
    });

    try {
      const result = await connection.client.callTool({
        name: "resourceportal_admin_get_bug_report_image",
        arguments: { reportId },
      });
      expect(result.isError).not.toBe(true);
      expect(result.content).toEqual([
        {
          type: "image",
          data: png.toString("base64"),
          mimeType: "image/png",
        },
      ]);
      expect(result.structuredContent).toMatchObject({
        status: 200,
        ok: true,
        mimeType: "image/png",
      });
    } finally {
      await connection.close();
    }
  });

  it("defense-in-depth rejects direct protocol calls by a non-platform-admin actor", async () => {
    const { service, audit } = fixture({ platformAdmin: false });
    const connection = await connectClient({
      service,
      request: mcpRequest({ authorization: "Bearer regular-user-token" }),
      authenticated: true,
    });

    try {
      const result = await connection.client.callTool({
        name: "resourceportal_admin_list_users",
        arguments: {},
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        status: 403,
        ok: false,
        data: {
          message: "ResourcePortal platform administrator access is required",
          error: "Forbidden",
          statusCode: 403,
        },
      });
      expect(audit.recordToolCall).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "resourceportal_admin_list_users",
          success: false,
        }),
      );
    } finally {
      await connection.close();
    }
  });

  it("documents the Platform Admin tenant boundary in a first-class capabilities tool", async () => {
    const { service } = fixture();
    const connection = await connectClient({
      service,
      request: mcpRequest({ authorization: "Bearer admin-token" }),
      authenticated: true,
    });

    try {
      const result = await connection.client.callTool({
        name: "resourceportal_admin_capabilities",
        arguments: {},
      });
      expect(result.structuredContent).toMatchObject({
        scope: "platform",
        boundaries: {
          tenantDirectory: "read-only",
          userDirectory: "read-only",
          tenantWorkloads: "not available",
          tenantMemberships: "not available",
          tenantConfiguration: "not available",
          arbitraryHttp: false,
          arbitrarySql: false,
          shellExecution: false,
          serviceIdentityAccess: false,
        },
      });
    } finally {
      await connection.close();
    }
  });
});
