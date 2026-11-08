/**
 * CI-only security feasibility probe for issue #398.
 *
 * The ZITADEL container in test/federation/docker-compose.yml runs with
 * network_mode=host, so it can call the localhost listener. This must NEVER
 * be installed in a live RP instance or advertised as an authorization gate.
 */
import assert from "node:assert/strict";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

export type ActionProofEvent = {
  userId: string | null;
  clientId: string | null;
  decision: "allow" | "deny";
};

export function verifyActionSignature(
  body: Buffer,
  header: string | undefined,
  signingKey: string,
  now = Date.now(),
): boolean {
  if (!header || !signingKey) return false;
  const match = /^t=(\d{10}),v1=([0-9a-f]{64})$/i.exec(header.replace(/\s+/g, ""));
  if (!match) return false;
  const timestamp = match[1];
  const received = match[2];
  if (Math.abs(now - Number(timestamp) * 1000) > 300_000) return false;
  const expected = createHmac("sha256", signingKey).update(timestamp + ".").update(body).digest();
  const actual = Buffer.from(received, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function startActionProof(input: {
  api: <T>(method: string, route: string, body?: unknown) => Promise<T>;
  issuer: string;
  testUserId: string;
  testProjectId: string;
  targetName?: string;
  // Optional production-service test policy. The HTTP listener stays CI-only,
  // but delegated authorization uses real RP Prisma grants and signed bytes.
  authorize?: (raw: Buffer, signature: string, signingKey: string) => Promise<void>;
}) {
  assert.equal(process.env.TENANT_OIDC_E2E_ISOLATED, "true");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(input.issuer, "https://localhost:8443");
  assert.match(input.testUserId, /^\d+$/);
  assert.match(input.testProjectId, /^\d+$/);

  const events: ActionProofEvent[] = [];
  let signingKey = "";
  let deniedClientId: string | null = null;
  let temporarilyUnavailable = false;
  const server = createServer((request, response) => {
    if (request.url === "/health" && request.method === "GET") {
      response.writeHead(200).end("ok");
      return;
    }
    if (request.url !== "/action" || request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk as Uint8Array));
        if (chunks.reduce((sum, c) => sum + c.length, 0) > 1_000_000) {
          response.writeHead(413).end();
          return;
        }
      }
      const raw = Buffer.concat(chunks);
      // ZITADEL's official Go SDK uses "ZITADEL-Signature" (without X-).
      // The older CreateTarget prose also calls it "X-ZITADEL-Signature".
      // Accept either spelling only when the HMAC actually verifies.
      const signature = request.headers["zitadel-signature"] ??
        request.headers["x-zitadel-signature"];
      if (!verifyActionSignature(raw, typeof signature === "string" ? signature : undefined, signingKey)) {
        response.writeHead(401).end();
        return;
      }
      const payload = JSON.parse(raw.toString("utf8")) as {
        function?: string;
        user?: { id?: string };
        application?: { client_id?: string };
        user_grants?: Array<{ projectId?: string }>;
      };
      const userId = payload.user?.id ?? null;
      const clientId = payload.application?.client_id ?? null;
      // Model an issuer-global target outage, not a missing entitlement. The
      // event records only immutable IDs from VERIFIED signed bytes. An
      // interrupting ZITADEL action must DENY token issuance on HTTP 503.
      if (temporarilyUnavailable) {
        events.push({ userId, clientId, decision: "deny" });
        response.writeHead(503).end();
        return;
      }
      // This probe is only authoritative for its one ephemeral user. Absent
      // client identity is always DENIED for this user; never infer by email.
      let denied = userId === input.testUserId &&
        (!clientId || clientId === deniedClientId);
      if (input.authorize) {
        // Invoke the actual server authorization service, never an unsigned
        // fixture policy. A rejection or database exception denies issuance.
        try {
          await input.authorize(raw, signature as string, signingKey);
          denied = false;
        } catch {
          denied = true;
        }
      }
      events.push({ userId, clientId, decision: denied ? "deny" : "allow" });
      response.writeHead(denied ? 403 : 200, {
        "content-type": "application/json",
      }).end("{}");
    })().catch(() => response.writeHead(500).end());
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(8090, "127.0.0.1", resolve);
  });

  try {
    const target = await input.api<{ id?: string; signingKey?: string }>(
      "POST", "/v2/actions/targets",
      { name: input.targetName ?? "rp-398-ephemeral-client-gate-proof", endpoint: "http://localhost:8090/action",
        timeout: "5s", restWebhook: { interruptOnError: true },
        payloadType: "PAYLOAD_TYPE_JSON" },
    );
    assert.match(target.id ?? "", /^\d+$/, "No isolated Action V2 target id");
    assert.ok(target.signingKey, "No isolated Action V2 signing key");
    signingKey = target.signingKey!;
    await input.api("PUT", "/v2/actions/executions", {
      condition: { function: { name: "preaccesstoken" } },
      targets: [target.id],
    });

    // Certify management read-back on the ACTUAL pinned ZITADEL container,
    // not merely successful POST/PUT or mocked API shapes. Production gate
    // verification uses these same two management endpoints and fields.
    const readBack = await input.api<{ target?: {
      id?: string; endpoint?: string; signingKey?: string;
      payloadType?: string; restWebhook?: { interruptOnError?: boolean };
    } }>("GET", "/v2/actions/targets/" + target.id);
    assert.ok(readBack.target, "Isolated Action target metadata is missing");
    assert.equal(readBack.target.id, target.id, "Isolated Action target readback lost its ID");
    assert.equal(readBack.target.endpoint, "http://localhost:8090/action",
      "Isolated Action target endpoint was modified during setup");
    assert.equal(readBack.target.signingKey, signingKey,
      "Isolated Action target signing key differs from creation response");
    assert.equal(readBack.target.payloadType, "PAYLOAD_TYPE_JSON",
      "Isolated Action target is not signed JSON");
    assert.equal(readBack.target.restWebhook?.interruptOnError, true,
      "Isolated Action target does not interrupt on authorization denial");
    const executions = await input.api<{ pagination?: { totalResult?: string | number };
      executions?: Array<{
        condition?: { function?: { name?: string } };
        targets?: string[];
      }>;
    }>("POST", "/v2/actions/executions/search", { pagination: { limit: 100 } });
    assert.ok(Array.isArray(executions.executions), "Isolated Action execution list is missing");
    assert.equal(Number(executions.pagination?.totalResult), executions.executions.length,
      "Isolated Action execution search is incomplete");
    const configured = executions.executions.filter(e =>
      e.condition?.function?.name === "preaccesstoken");
    assert.equal(configured.length, 1, "Isolated preaccesstoken execution is not unique");
    assert.deepEqual(configured[0].targets, [target.id],
      "Isolated signed Action target is not the sole preaccesstoken execution");
    console.log("PASS: real ZITADEL Actions V2 target signing metadata and execution readback");

    let closed = false;
    return {
      events: () => events.map(e => ({ ...e })),
      denyClient(clientId: string) { assert.ok(clientId); deniedClientId = clientId; },
      simulateOutage(enabled: boolean) { temporarilyUnavailable = enabled; },
      async close() {
        if (closed) return;
        closed = true;
        // Fail closed on failure to detach. The whole isolated issuer is
        // destroyed at the end of the GitHub runner regardless of this step.
        try {
          await input.api("PUT", "/v2/actions/executions", {
            condition: { function: { name: "preaccesstoken" } },
            targets: [],
          });
        } finally {
          await new Promise<void>(resolve => server.close(() => resolve()));
        }
      },
    };
  } catch (error) {
    await new Promise<void>(resolve => server.close(() => resolve()));
    throw error;
  }
}
