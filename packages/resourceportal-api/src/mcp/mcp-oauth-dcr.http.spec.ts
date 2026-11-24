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
    ZITADEL_DCR_DEFAULT_ORGANIZATION_ID: "401000000000000000",
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
      "ZITADEL OAuth client registration may have been accepted",
    );
    expect(Date.now() - start).toBeLessThan(2600);
    expect(requests).toBe(1);
  });

  it("sanitizes a real HTTP 400 response body that stalls after error headers", async () => {
    let requests = 0;
    const service = await withUpstream((req, res) => {
      expect(req.url).toBe("/oauth/v2/register");
      requests += 1;
      res.writeHead(400, { "content-type": "application/json", "transfer-encoding": "chunked" });
      res.write('{"error":"invalid_client_metadata","secret":"do-not-leak');
      // ZITADEL explicitly rejected registration, but never finished its
      // error body: this must not surface a raw AbortError or credentials.
    });
    const start = Date.now();
    let failure: unknown;
    try { await service.register({ client_name: "synthetic-error-body-stall" }); }
    catch (error) { failure = error && typeof error === "object" && "getResponse" in error
      ? (error as { getResponse: () => unknown }).getResponse() : error; }
    expect(failure).toMatchObject({ statusCode: 502,
      message: "ZITADEL DCR upstream response unavailable or timed out" });
    expect(JSON.stringify(failure)).not.toContain("do-not-leak");
    expect(Date.now() - start).toBeLessThan(2600);
    expect(requests).toBe(1);
  });

  it("bounds a real HTTP 201 response body that stalls after the headers", async () => {
    let accepted = 0;
    const service = await withUpstream((req, res) => {
      expect(req.url).toBe("/oauth/v2/register");
      accepted += 1;
      res.writeHead(201, { "content-type": "application/json", "transfer-encoding": "chunked" });
      res.write('{"client_id":"unrecoverable-');
      // Deliberately never end the response: upstream registration could
      // already have committed, so the client cannot assume safe retry.
    });
    const start = Date.now();
    let publicError: unknown;
    try { await service.register({ client_name: "synthetic-chunked-stall" }); }
    catch (error) {
      publicError = error && typeof error === "object" && "getResponse" in error
        ? (error as { getResponse: () => unknown }).getResponse() : error;
    }
    expect(publicError).toMatchObject({ code: "DCR_REGISTRATION_OUTCOME_UNCERTAIN" });
    expect(Date.now() - start).toBeLessThan(2600);
    expect(accepted).toBe(1);
  });

  it("rejects a real registration HTTP redirect without forwarding caller authorization", async () => {
    const calls: string[] = [];
    const service = await withUpstream((req, res) => {
      calls.push(`${req.method} ${req.url}`);
      if (req.url === "/oauth/v2/register") {
        expect(req.headers.authorization).toBe("Bearer caller-registration-token");
        res.writeHead(307, { location: "/credential-capture" }).end();
      } else {
        throw new Error(`Registration Bearer reached redirected path: ${req.url}`);
      }
    });
    let publicError: unknown;
    try { await service.register({ client_name: "test" }, "Bearer caller-registration-token"); }
    catch (error) {
      publicError = error && typeof error === "object" && "getResponse" in error
        ? (error as { getResponse: () => unknown }).getResponse() : error;
    }
    expect(publicError).toMatchObject({ code: "DCR_REGISTRATION_OUTCOME_UNCERTAIN" });
    expect(JSON.stringify(publicError)).not.toContain("caller-registration-token");
    expect(calls).toEqual(["POST /oauth/v2/register"]);
  });

  it("marks an accepted POST with a dropped HTTP response as uncertain, never safe-to-retry", async () => {
    let created = 0;
    const service = await withUpstream((_req, res) => {
      created += 1; // issuer persisted registration before losing the response
      res.destroy();
    });
    let publicError: unknown;
    try { await service.register({ client_name: "synthetic-dropped-response" }); } catch (error) {
      publicError = error && typeof error === "object" && "getResponse" in error
        ? (error as { getResponse: () => unknown }).getResponse() : error;
    }
    expect(publicError).toMatchObject({ code: "DCR_REGISTRATION_OUTCOME_UNCERTAIN" });
    expect(JSON.stringify(publicError)).toContain("reconcile upstream clients before retrying");
    expect(created).toBe(1);
  });

  it.each(["https", "http"])("compensates real HTTP registration with %s issuer-host metadata and DELETE confirms cleanup", async (scheme) => {
    const calls: string[] = [];
    let clientExists = false;
    const service = await withUpstream((req, res) => {
      calls.push(`${req.method} ${req.url}`);
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && req.url === "/oauth/v2/register") {
        clientExists = true;
        res.writeHead(201).end(JSON.stringify({
          client_id: "synthetic-client",
          registration_access_token: "rollback-only-secret",
          registration_client_uri: `${scheme}://auth-synthetic.invalid/oauth/v2/register/synthetic-client`,
        }));
      } else if (req.method === "POST" && req.url === "/management/v1/projects/_search") {
        expect(req.headers.authorization).toBe("Bearer synthetic-management-token");
        res.writeHead(503).end('{}');
      } else if (req.method === "DELETE" && req.url === "/oauth/v2/register/synthetic-client") {
        expect(req.headers.authorization).toBe("Bearer rollback-only-secret");
        clientExists = false;
        res.writeHead(204).end();
      } else if (req.method === "GET" && req.url === "/oauth/v2/register/synthetic-client") {
        res.writeHead(404).end();
      } else {
        res.writeHead(500).end('{}');
      }
    });
    await expect(service.register({})).rejects.toThrow("compatibility update failed with HTTP 503");
    expect(clientExists).toBe(false);
    expect(calls).toEqual([
      "POST /oauth/v2/register",
      "POST /management/v1/projects/_search",
      "DELETE /oauth/v2/register/synthetic-client",
      "GET /oauth/v2/register/synthetic-client",
    ]);
  });

  it("rejects a real management redirect without forwarding the management Bearer", async () => {
    const calls: string[] = [];
    const service = await withUpstream((req, res) => {
      calls.push(`${req.method} ${req.url}`);
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && req.url === "/oauth/v2/register") {
        res.writeHead(201).end(JSON.stringify({
          client_id: "synthetic-client",
          registration_access_token: "registration-only-secret",
          registration_client_uri: "https://auth-synthetic.invalid/oauth/v2/register/synthetic-client",
        }));
      } else if (req.method === "POST" && req.url === "/management/v1/projects/_search") {
        expect(req.headers.authorization).toBe("Bearer synthetic-management-token");
        res.writeHead(307, { location: "/credential-capture" }).end();
      } else if (req.method === "DELETE" && req.url === "/oauth/v2/register/synthetic-client") {
        expect(req.headers.authorization).toBe("Bearer registration-only-secret");
        res.writeHead(204).end();
      } else if (req.method === "GET" && req.url === "/oauth/v2/register/synthetic-client") {
        res.writeHead(404).end();
      } else {
        throw new Error(`Unexpected redirected request: ${req.method} ${req.url}`);
      }
    });
    await expect(service.register({})).rejects.toThrow("ZITADEL DCR upstream request unavailable or timed out");
    // The registration is compensable; the upstream redirect must never
    // be followed and the credential may not reach /credential-capture.
    expect(calls).toEqual([
      "POST /oauth/v2/register",
      "POST /management/v1/projects/_search",
      "DELETE /oauth/v2/register/synthetic-client",
      "GET /oauth/v2/register/synthetic-client",
    ]);
  });

  it("never follows a real HTTP 307 rollback redirect with registration Bearer to another endpoint", async () => {
    const calls: string[] = [];
    const service = await withUpstream((req, res) => {
      calls.push(`${req.method} ${req.url}`);
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && req.url === "/oauth/v2/register") {
        res.writeHead(201).end(JSON.stringify({
          client_id: "synthetic-client",
          registration_access_token: "rollback-only-secret",
          registration_client_uri: "http://auth-synthetic.invalid/oauth/v2/register/synthetic-client",
        }));
      } else if (req.method === "POST" && req.url === "/management/v1/projects/_search") {
        res.writeHead(503).end('{}');
      } else if (req.method === "DELETE" && req.url === "/oauth/v2/register/synthetic-client") {
        expect(req.headers.authorization).toBe("Bearer rollback-only-secret");
        res.writeHead(307, { location: "/untrusted-endpoint" }).end();
      } else {
        throw new Error(`Unexpected redirected request: ${req.method} ${req.url}`);
      }
    });
    let publicError: unknown;
    try { await service.register({}); } catch (error) {
      publicError = error && typeof error === "object" && "getResponse" in error
        ? (error as { getResponse: () => unknown }).getResponse() : error;
    }
    expect(publicError).toMatchObject({ code: "DCR_PARTIAL_REGISTRATION", clientId: "synthetic-client" });
    expect(JSON.stringify(publicError)).not.toContain("rollback-only-secret");
    expect(calls).toEqual([
      "POST /oauth/v2/register",
      "POST /management/v1/projects/_search",
      "DELETE /oauth/v2/register/synthetic-client",
    ]);
  });

  it("bounds a stalled real management request after HTTP 201 and confirms DELETE cleanup", async () => {
    const calls: string[] = [];
    let clientExists = false;
    const service = await withUpstream((req, res) => {
      calls.push(`${req.method} ${req.url}`);
      if (req.method === "POST" && req.url === "/oauth/v2/register") {
        clientExists = true;
        res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({
          client_id: "management-stall-client",
          registration_access_token: "rollback-only-secret",
          registration_client_uri: "https://auth-synthetic.invalid/oauth/v2/register/management-stall-client",
        }));
      } else if (req.method === "POST" && req.url === "/management/v1/projects/_search") {
        expect(req.headers.authorization).toBe("Bearer synthetic-management-token");
        res.writeHead(200, { "content-type": "application/json", "transfer-encoding": "chunked" });
        res.write('{"result":'); // never finish management response
      } else if (req.method === "DELETE" && req.url === "/oauth/v2/register/management-stall-client") {
        expect(req.headers.authorization).toBe("Bearer rollback-only-secret");
        clientExists = false;
        res.writeHead(204).end();
      } else if (req.method === "GET" && req.url === "/oauth/v2/register/management-stall-client") {
        res.writeHead(404).end();
      } else {
        throw new Error(`Unexpected request: ${req.method} ${req.url}`);
      }
    });
    const start = Date.now();
    await expect(service.register({})).rejects.toThrow("ZITADEL DCR upstream response unavailable or timed out");
    expect(Date.now() - start).toBeLessThan(2600);
    expect(clientExists).toBe(false);
    expect(calls).toEqual([
      "POST /oauth/v2/register",
      "POST /management/v1/projects/_search",
      "DELETE /oauth/v2/register/management-stall-client",
      "GET /oauth/v2/register/management-stall-client",
    ]);
  });

  it("classifies a real rollback DELETE stall as partial, never a confirmed cleanup", async () => {
    let clientExists = false;
    const calls: string[] = [];
    const service = await withUpstream((req, res) => {
      calls.push(`${req.method} ${req.url}`);
      if (req.method === "POST" && req.url === "/oauth/v2/register") {
        clientExists = true;
        res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({
          client_id: "stalled-rollback-client",
          registration_access_token: "rollback-only-secret",
          registration_client_uri: "https://auth-synthetic.invalid/oauth/v2/register/stalled-rollback-client",
        }));
      } else if (req.method === "POST" && req.url === "/management/v1/projects/_search") {
        res.writeHead(503).end('{}');
      } else if (req.method === "DELETE" && req.url === "/oauth/v2/register/stalled-rollback-client") {
        expect(req.headers.authorization).toBe("Bearer rollback-only-secret");
        // Do not send even response headers; a successful HTTP status would
        // count as confirmation of deletion, regardless of a stalled body.
        // This simulates an issuer that never acknowledges DELETE at all.
      } else {
        throw new Error(`Unexpected request: ${req.method} ${req.url}`);
      }
    });
    const start = Date.now();
    let publicError: unknown;
    try { await service.register({}); } catch (error) {
      publicError = error && typeof error === "object" && "getResponse" in error
        ? (error as { getResponse: () => unknown }).getResponse() : error;
    }
    expect(publicError).toMatchObject({ code: "DCR_PARTIAL_REGISTRATION", clientId: "stalled-rollback-client" });
    expect(JSON.stringify(publicError)).not.toContain("rollback-only-secret");
    expect(Date.now() - start).toBeLessThan(2600);
    expect(clientExists).toBe(true);
    expect(calls).toEqual([
      "POST /oauth/v2/register",
      "POST /management/v1/projects/_search",
      "DELETE /oauth/v2/register/stalled-rollback-client",
    ]);
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
