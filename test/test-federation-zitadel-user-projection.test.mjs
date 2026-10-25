import test from "node:test";
import assert from "node:assert/strict";
import { waitForZitadelUserProjection } from "../scripts/federation-zitadel-user-projection.mjs";

const input = {
  origin: "http://localhost:8080",
  managementToken: "test-management-token",
  organizationId: "test-organization",
  email: "oidc-user@example.test",
};
const ready = {
  result: [{
    id: "new-projected-subject",
    human: { email: { email: "oidc-user@example.test" } },
    state: "USER_STATE_ACTIVE",
  }],
};
const ok = (payload) => ({
  ok: true,
  status: 200,
  json: async () => payload,
});
const absent = ok({ result: [] });

test("waits for actual ZITADEL projection before first federated MFA completion", async () => {
  const requests = [];
  const pauses = [];
  const responses = [absent, absent, ok(ready)];
  const userId = await waitForZitadelUserProjection({
    ...input,
    attempts: 5,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return responses.shift();
    },
    sleep: async (ms) => pauses.push(ms),
  });
  assert.equal(userId, "new-projected-subject");
  assert.deepEqual(pauses, [250, 250]);
  assert.equal(requests.length, 3);
  for (const { url, options } of requests) {
    assert.equal(url, "http://localhost:8080/management/v1/users/_search");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.authorization, "Bearer test-management-token");
    assert.equal(options.headers["x-zitadel-orgid"], "test-organization");
    assert.deepEqual(JSON.parse(options.body).queries, [{
      emailQuery: {
        emailAddress: "oidc-user@example.test",
        method: "TEXT_QUERY_METHOD_EQUALS",
      },
    }]);
  }
});

test("ignores foreign email, missing subject and pending users", async () => {
  const notReady = [
    { id: "other-subject", state: "USER_STATE_ACTIVE", human: { email: { email: "foreign@example.test" } } },
    { id: "", state: "USER_STATE_ACTIVE", human: { email: { email: input.email } } },
    { id: "pending-subject", state: "USER_STATE_INITIAL", human: { email: { email: input.email } } },
  ];
  await assert.rejects(
    waitForZitadelUserProjection({
      ...input,
      attempts: 2,
      fetchImpl: async () => ok({ result: notReady }),
      sleep: async () => {},
    }),
    /not readable after 2 checks/,
  );
});

test("fails immediately on unauthorized management access (no skipped login)", async () => {
  let calls = 0;
  await assert.rejects(
    waitForZitadelUserProjection({
      ...input,
      fetchImpl: async () => { calls++; return { ok: false, status: 401 }; },
      sleep: async () => assert.fail("Should never sleep/retry bad credentials"),
    }),
    /HTTP 401/,
  );
  assert.equal(calls, 1);
});

test("does not accept malformed 200 as a valid projection", async () => {
  await assert.rejects(waitForZitadelUserProjection({
    ...input,
    fetchImpl: async () => ok({ unexpected: "ok" }),
  }), /did not return a user list/);
});

test("rejects missing management identity and unauthenticated projection checks", async () => {
  await assert.rejects(waitForZitadelUserProjection({ ...input, managementToken: "" }),
    /lacks authenticated configuration/);
  await assert.rejects(waitForZitadelUserProjection({ ...input, attempts: 0 }),
    /lacks authenticated configuration/);
});
