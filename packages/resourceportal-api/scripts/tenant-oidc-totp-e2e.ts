/**
 * Real TOTP registration + password + second-factor verification against
 * the isolated, pinned HTTPS ZITADEL GitHub Actions issuer only.
 * Credentials and TOTP secrets are synthetic and NEVER logged or persisted.
 * This is a factor/session integration, NOT a production MFA policy proof.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

type IsolatedApi = <T>(method: string, route: string, body?: unknown, deadline?: number) => Promise<T>;

function totp(secret: string): string {
  assert.match(secret, /^[A-Z2-7]+=*$/i, "ZITADEL TOTP registration secret invalid");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  for (const character of secret.replace(/=+$/, "").toUpperCase()) {
    const digit = alphabet.indexOf(character);
    assert.ok(digit >= 0);
    value = (value << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 255);
    }
  }
  assert.ok(bytes.length >= 10, "TOTP secret too short");
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  const value31 = (
    ((digest[offset] & 127) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3]
  ) >>> 0;
  return String(value31 % 1_000_000).padStart(6, "0");
}

export async function proveIsolatedTotpMfa(input: {
  api: IsolatedApi;
  userId: string;
  loginName: string;
  password: string;
}) {
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.TENANT_OIDC_E2E_ISOLATED, "true");
  assert.equal(process.env.OIDC_ISSUER_URL, "https://localhost:8443");
  assert.ok(process.env.NODE_EXTRA_CA_CERTS);
  assert.match(input.userId, /^\d+$/);
  assert.match(input.loginName, /^oidc-live-[a-f0-9-]+-a$/);

  const root = "/v2/users/" + encodeURIComponent(input.userId);
  const enrolled = await input.api<{ secret?: string }>("POST", root + "/totp", {});
  const secret = enrolled.secret;
  assert.ok(secret && secret.length > 12, "Real ZITADEL did not issue a TOTP secret");
  await input.api("POST", root + "/totp/verify", { code: totp(secret) });

  const createSession = async () => {
    const created = await input.api<{ sessionId?: string; sessionToken?: string }>(
      "POST", "/v2/sessions", { checks: { user: { loginName: input.loginName } } },
    );
    assert.ok(created.sessionId && created.sessionToken, "Session user check failed");
    const sessionPath = "/v2/sessions/" + encodeURIComponent(created.sessionId);
    const passwordCheck = await input.api<{ sessionToken?: string }>(
      "PATCH", sessionPath, { checks: { password: { password: input.password } } },
    );
    assert.ok(passwordCheck.sessionToken, "Session password check failed");
    const before = await input.api<{ session?: { factors?: {
      user?: { id?: string }; password?: { verifiedAt?: string }; totp?: { verifiedAt?: string };
    } } }>("GET", sessionPath);
    assert.equal(before.session?.factors?.user?.id, input.userId);
    assert.ok(before.session?.factors?.password?.verifiedAt, "Password factor absent");
    assert.ok(!before.session?.factors?.totp?.verifiedAt, "TOTP already passed before challenge");
    return sessionPath;
  };

  const correctSession = await createSession();
  const successful = await input.api<{ sessionToken?: string }>(
    "PATCH", correctSession, { checks: { totp: { code: totp(secret) } } },
  );
  assert.ok(successful.sessionToken, "Real TOTP authentication returned no new session token");
  const after = await input.api<{ session?: { factors?: {
    user?: { id?: string }; password?: { verifiedAt?: string }; totp?: { verifiedAt?: string };
  } } }>("GET", correctSession);
  assert.equal(after.session?.factors?.user?.id, input.userId);
  assert.ok(after.session?.factors?.password?.verifiedAt, "Password factor lost after MFA");
  assert.ok(after.session?.factors?.totp?.verifiedAt, "Real ZITADEL did not verify second factor");

  // An incorrect TOTP must NOT be accepted on a separately password-checked
  // synthetic session. The wrong code is deliberately different from current.
  const deniedSession = await createSession();
  const valid = totp(secret);
  const invalid = String((Number(valid) + 1) % 1_000_000).padStart(6, "0");
  await assert.rejects(
    () => input.api("PATCH", deniedSession, { checks: { totp: { code: invalid } } }),
    /returned HTTP 4\d\d/,
    "ZITADEL accepted invalid TOTP",
  );
  const denied = await input.api<{ session?: { factors?: {
    totp?: { verifiedAt?: string }; password?: { verifiedAt?: string };
  } } }>("GET", deniedSession);
  assert.ok(denied.session?.factors?.password?.verifiedAt);
  assert.ok(!denied.session?.factors?.totp?.verifiedAt,
    "Invalid TOTP incorrectly verified the second factor");

  console.log("PASS: isolated real ZITADEL TOTP registration, password+TOTP session factors, invalid-code denial (no secrets logged)");
}
