/** Real loopback HTTP fault injection for issue #213; no production ZITADEL access. */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { ConfigService } from "@nestjs/config";
import { afterEach, describe, expect, it } from "vitest";
import { McpOAuthDcrService } from "./mcp-oauth-dcr.service";

const activeServers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  for (const server of activeServers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function withUpstream(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  activeServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  const config = { get: (key: string) => ({
    ZITADEL_INTERNAL_URL: `http://127.0.0.1:${address.port}`,
    OIDC_ISSUER_URL: "https://auth-synthetic.invalid",
    ZITADEL_MANAGEMENT_TOKEN: "synthetic-management-token",
    ZITADEL_DCR_REQUEST_TIMEOUT_MS: "500",
    ZITADEL_DCR_REGISTRATION_TIMEOUT_MS: "3000",
  })[key as "ZITADEL_INTERNAL_URL" | "OIDC_ISSUER_URL" | "ZITADEL_MANAGEMENT_TOKEN" | "ZITADEL_DCR_REQUEST_TIMEOUT_MS" | "ZITADEL_DCR_REGISTRATION_TIMEOUT_MS"] } as unknown as ConfigService;
  return new McpOAuthDcrService(config);
}

describe("DCR real HTTP fault injection (#213)", () => {
  it("terminates a genuinely stalled HTTP registration without waiting indefinitely", async () => {
    let requests = 0;
    const service = await withUpstream(() => { requests += 1; });
    const start = Date.now();
    await expect(service.register({ client_name: "synthetic" })).rejects.toThrow(
      "ZITADEL DCR upstream request unavailable or timed out",
    );
    expect(Date.now() - start).toBeLessThan(2600);
    expect(requests).toBe(1);
  });

  it("classifies the actual HTTP 201 + management 503 + rollback DELETE 503 orphan", async () => {
    const methods: string[] = [];
    let upstreamClientExists = false;
    const service = await withUpstream((req, res) => {
      const route = req.url ?? "";
      methods.push(`${req.method} ${route}`);
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && route === "/oauth/v2/register") {
        upstreamClientExists = true;
        res.writeHead(201).end(JSON.stringify({
          client_id: "synthetic-client",
          registration_access_token: "secret-do-not-return",
          registration_client_uri: "https://auth-synthetic.invalid/oauth/v2/register/synthetic-client",
        }));
      } else if (req.method === "POST" && route === "/management/v1/projects/_search") {
        res.writeHead(503).end('{"error":"management unavailable"}');
      } else if (req.method === "DELETE" && route === "/oauth/v2/register/synthetic-client") {
        res.writeHead(503).end('{"error":"rollback unavailable"}');
      } else {
        res.writeHead(500).end('{}');
      }
    });
    let publicError: unknown;
    try { await service.register({}); } catch (error) {
      publicError = error && typeof error === "object" && "getResponse" in error
        ? (error as { getResponse: () => unknown }).getResponse() : error;
    }
    expect(publicError).toMatchObject({ code: "DCR_PARTIAL_REGISTRATION", clientId: "synthetic-client" });
    expect(JSON.stringify(publicError)).not.toContain("secret-do-not-return");
    expect(JSON.stringify(publicError)).not.toContain("synthetic-management-token");
    expect(upstreamClientExists).toBe(true); // exact observable partial/orphan state
    expect(methods).toEqual([
      "POST /oauth/v2/register",
      "POST /management/v1/projects/_search",
      "DELETE /oauth/v2/register/synthetic-client",
    ]);
  });
});
