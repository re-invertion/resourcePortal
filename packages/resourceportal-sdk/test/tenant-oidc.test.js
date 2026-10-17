const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ResourcePortalClient } = require("..");

function mockClient() {
  const requests = [];
  const client = new ResourcePortalClient({
    apiUrl: "https://rp.example/api",
    token: "fake-token",
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({ tenantId: "tenant-1", enabled: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { client, requests };
}

test("tenant OIDC SDK only sends tenant-scoped requests to the corresponding endpoints", async () => {
  const { client, requests } = mockClient();
  await client.tenantOidc.get("tenant 1");
  await client.tenantOidc.provision("tenant 1");
  await client.tenantOidc.reconcileGrants("tenant 1");
  await client.tenantOidc.disable("tenant 1");
  await client.tenantOidc.delete("tenant 1");
  const seen = requests.map(r => [new URL(r.url).pathname, r.init.method]);
  assert.deepEqual(seen, [
    ["/api/tenants/tenant%201/oidc-provider", "GET"],
    ["/api/tenants/tenant%201/oidc-provider/provision", "POST"],
    ["/api/tenants/tenant%201/oidc-provider/reconcile-grants", "POST"],
    ["/api/tenants/tenant%201/oidc-provider/disable", "POST"],
    ["/api/tenants/tenant%201/oidc-provider", "DELETE"],
  ]);
});
test("retirement preflight in SDK is read-only", async () => {
  const { client, requests } = mockClient();
  await client.nativeLoginMigration.preflight();
  assert.equal(new URL(requests[0].url).pathname,
    "/api/platform/identity-providers/retirement-preflight");
  assert.equal(requests[0].init.method, "GET");
});
