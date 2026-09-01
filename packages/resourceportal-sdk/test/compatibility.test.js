const test = require("node:test");
const assert = require("node:assert/strict");
const { ResourcePortalApiError, ResourcePortalClient } = require("..");

function jsonResponse(body = { ok: true }, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

function recordingClient(options = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return options.responseFactory
      ? options.responseFactory(url, init)
      : jsonResponse();
  };
  const client = new ResourcePortalClient({
    apiUrl: "https://rp.example/api",
    token: "token",
    devUserId: "dev-user",
    correlationId: "corr-client",
    requestId: "req-client",
    fetchImpl,
  });
  return { calls, client };
}

function pathOf(call) {
  return new URL(call.url).pathname;
}

test("exposes every post-Stage-8 public management resource family", async () => {
  const { client, calls } = recordingClient();

  await client.platformBilling.listPriceLists();
  await client.platformInfrastructure.getSwarmCluster();
  await client.storageBackends.list();
  await client.operations.list("tenant id");
  await client.platformMaintenance.get();
  await client.oauthApplications.list("tenant id");
  await client.platformOauthApplications.list();
  await client.serviceIdentities.list("tenant id");
  await client.platformServiceIdentities.list();
  await client.platformIdentityProviders.list();

  assert.deepEqual(
    calls.map(pathOf),
    [
      "/api/platform/billing/price-lists",
      "/api/platform/swarm-cluster",
      "/api/platform/storage-backends",
      "/api/tenants/tenant%20id/operations",
      "/api/platform/maintenance",
      "/api/tenants/tenant%20id/oauth-applications",
      "/api/platform/oauth-applications",
      "/api/tenants/tenant%20id/service-identities",
      "/api/platform/service-identities",
      "/api/platform/identity-providers",
    ],
  );
});

test("uses canonical methods and bodies for representative mutations", async () => {
  const { client, calls } = recordingClient();

  await client.platformInfrastructure.reconcileSwarmCluster();
  await client.platformInfrastructure.setRemoteLocationMaintenance("location id", true);
  await client.storageBackends.setMaintenance("backend id", false);
  await client.operations.retry("tenant id", "operation id");
  await client.platformMaintenance.set({ enabled: true, reason: "upgrade" });
  await client.oauthApplications.rotateCredentials("tenant id", "oauth id");
  await client.platformServiceIdentities.rotateCredentials("service id");

  assert.deepEqual(
    calls.map((call) => [call.init.method ?? "GET", pathOf(call)]),
    [
      ["POST", "/api/platform/swarm-cluster/reconcile"],
      ["PATCH", "/api/platform/remote-locations/location%20id/maintenance"],
      ["PATCH", "/api/platform/storage-backends/backend%20id/maintenance"],
      ["POST", "/api/tenants/tenant%20id/operations/operation%20id/retry"],
      ["PATCH", "/api/platform/maintenance"],
      ["POST", "/api/tenants/tenant%20id/oauth-applications/oauth%20id/rotate-credentials"],
      ["POST", "/api/platform/service-identities/service%20id/rotate-credentials"],
    ],
  );
  assert.equal(calls[1].init.body, JSON.stringify({ enabled: true }));
  assert.equal(calls[2].init.body, JSON.stringify({ enabled: false }));
  assert.equal(
    calls[4].init.body,
    JSON.stringify({ enabled: true, reason: "upgrade" }),
  );
});

test("serializes audit filters and supports text audit export", async () => {
  let responseIndex = 0;
  const { client, calls } = recordingClient({
    responseFactory: () => {
      responseIndex += 1;
      if (responseIndex === 1) return jsonResponse({ items: [] });
      return new Response("id,action\n1,DEPLOY\n", {
        status: 200,
        headers: { "content-type": "text/csv; charset=utf-8" },
      });
    },
  });

  await client.auditLog.list("tenant id", {
    action: "DEPLOY",
    actor: "user@example.com",
    correlationId: "corr filter",
    limit: 25,
  });
  const exported = await client.auditLog.export("tenant id", {
    action: "DEPLOY",
    format: "csv",
  });

  const listUrl = new URL(calls[0].url);
  assert.equal(listUrl.pathname, "/api/tenants/tenant%20id/audit-log");
  assert.equal(listUrl.searchParams.get("action"), "DEPLOY");
  assert.equal(listUrl.searchParams.get("actor"), "user@example.com");
  assert.equal(listUrl.searchParams.get("correlationId"), "corr filter");
  assert.equal(listUrl.searchParams.get("limit"), "25");

  const exportUrl = new URL(calls[1].url);
  assert.equal(exportUrl.pathname, "/api/tenants/tenant%20id/audit-log/export");
  assert.equal(exportUrl.searchParams.get("format"), "csv");
  assert.equal(exported, "id,action\n1,DEPLOY\n");
});

test("returns Prometheus metrics as text instead of parsing JSON", async () => {
  const { client } = recordingClient({
    responseFactory: () =>
      new Response("resourceportal_up 1\n", {
        status: 200,
        headers: {
          "content-type": "text/plain; version=0.0.4; charset=utf-8",
        },
      }),
  });

  assert.equal(await client.metrics.get(), "resourceportal_up 1\n");
});

test("propagates client and request correlation identifiers", async () => {
  const { client, calls } = recordingClient();

  await client.account.me();
  await client.request("/auth/me", {
    correlationId: "corr-override",
    requestId: "req-override",
  });

  const firstHeaders = new Headers(calls[0].init.headers);
  assert.equal(firstHeaders.get("x-correlation-id"), "corr-client");
  assert.equal(firstHeaders.get("x-request-id"), "req-client");

  const secondHeaders = new Headers(calls[1].init.headers);
  assert.equal(secondHeaders.get("x-correlation-id"), "corr-override");
  assert.equal(secondHeaders.get("x-request-id"), "req-override");
});

test("exposes structured API error metadata", async () => {
  const { client } = recordingClient({
    responseFactory: () =>
      jsonResponse(
        {
          error: {
            code: "OPERATION_CONFLICT",
            message: "Operation conflict",
            statusCode: 409,
            requestId: "request-from-body",
            details: { operationId: "op-1" },
          },
        },
        {
          status: 409,
          headers: { "x-correlation-id": "correlation-from-header" },
        },
      ),
  });

  await assert.rejects(
    () => client.account.me(),
    (error) => {
      assert.ok(error instanceof ResourcePortalApiError);
      assert.equal(error.status, 409);
      assert.equal(error.code, "OPERATION_CONFLICT");
      assert.deepEqual(error.details, { operationId: "op-1" });
      assert.equal(error.requestId, "request-from-body");
      assert.equal(error.correlationId, "correlation-from-header");
      return true;
    },
  );
});
