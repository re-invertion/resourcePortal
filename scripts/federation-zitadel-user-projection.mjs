/** Await ZITADEL's *real* user read projection after first-time federation.
 *
 * ZITADEL creates linked users in its event store, then asynchronously builds
 * the projection used by /oauth/v2/token (GetOIDCUserInfo). Completing the
 * MFA-prompt immediately can redeem a one-time authorization code before the
 * projection is readable, yielding Errors.User.NotFound and losing the code.
 *
 * This is only an E2E readiness assertion; it never creates a user, repeats a
 * code redemption, treats a failed sign-in as success, or changes RP auth.
 */
export async function waitForZitadelUserProjection({
  origin, managementToken, organizationId, email,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  attempts = 60,
  intervalMs = 250,
}) {
  if (!origin || !managementToken || !organizationId || !email ||
      !Number.isInteger(attempts) || attempts < 1 ||
      !Number.isInteger(intervalMs) || intervalMs < 0) {
    throw new Error("ZITADEL projection check lacks authenticated configuration");
  }
  const expectedEmail = email.toLowerCase();
  const url = origin.replace(/\/$/, "") + "/management/v1/users/_search";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await fetchImpl(url, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: {
        authorization: `Bearer ${managementToken}`,
        "content-type": "application/json",
        "x-zitadel-orgid": organizationId,
      },
      body: JSON.stringify({
        query: { limit: 20 },
        queries: [{ emailQuery: {
          emailAddress: email,
          method: "TEXT_QUERY_METHOD_EQUALS",
        } }],
      }),
    });
    if (!response.ok) {
      throw new Error(`ZITADEL projection lookup returned HTTP ${response.status}`);
    }
    const body = await response.json();
    if (!Array.isArray(body?.result)) {
      throw new Error("ZITADEL projection lookup did not return a user list");
    }
    const user = body.result.find((item) =>
      typeof item?.id === "string" && item.id.length > 0 &&
      item.human?.email?.email?.toLowerCase() === expectedEmail &&
      item.state === "USER_STATE_ACTIVE");
    if (user) return user.id;
    if (attempt + 1 < attempts) await sleep(intervalMs);
  }
  throw new Error(
    `ZITADEL federated user projection was not readable after ${attempts} checks for ${expectedEmail}`,
  );
}
