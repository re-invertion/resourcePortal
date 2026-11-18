/* Real TLS proof: a public issuer DNS name is unresolvable from this
 * process, yet HTTPS discovery/token/JWKS/UserInfo succeed via a private
 * backend IP. SNI, Host and certificate validation remain public. */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const https = require("node:https");

const { OidcIssuerTransport } = require("../../packages/resourceportal-api/dist/src/auth/oidc-issuer-transport.js");
const { OidcAuthService } = require("../../packages/resourceportal-api/dist/src/auth/oidc-auth.service.js");
let publicJwk;
const hostname = "auth.rp-oidc-private.invalid";
const server = https.createServer({
  key: fs.readFileSync(process.env.OIDC_TEST_KEY_FILE),
  cert: fs.readFileSync(process.env.OIDC_TEST_CA_FILE),
}, (req, res) => {
  try {
    assert.equal(req.headers.host, `${hostname}:${server.address().port}`);
    assert.equal(req.socket.servername, hostname);
    const origin = `https://${hostname}:${server.address().port}`;
    res.setHeader("content-type", "application/json");
    switch (req.url) {
      case "/.well-known/openid-configuration":
        res.end(JSON.stringify({
          issuer: origin,
          authorization_endpoint: origin + "/oauth/v2/authorize",
          token_endpoint: origin + "/oauth/v2/token",
          jwks_uri: origin + "/oauth/v2/keys",
          userinfo_endpoint: origin + "/oidc/v1/userinfo",
        }));
        break;
      case "/oauth/v2/keys":
        res.end(JSON.stringify({ keys: [publicJwk] }));
        break;
      case "/oauth/v2/token":
        res.end(JSON.stringify({ access_token: "example", token_type: "Bearer" }));
        break;
      case "/oidc/v1/userinfo":
        res.end(JSON.stringify({ sub: "example" }));
        break;
      default:
        res.statusCode = 404;
        res.end("{}");
    }
  } catch (err) {
    res.statusCode = 500;
    res.end("{}");
    process.stderr.write("OIDC TLS routing proof failed: hostname/SNI mismatch\n");
  }
});

async function main() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const issuer = `https://${hostname}:${server.address().port}`;
  const jose = await import("jose");
  const pair = await jose.generateKeyPair("RS256");
  publicJwk = await jose.exportJWK(pair.publicKey);
  publicJwk.kid = "private-route-signing-key";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  const token = await new jose.SignJWT({ email_verified: true })
    .setProtectedHeader({ alg: "RS256", kid: publicJwk.kid })
    .setIssuer(issuer)
    .setAudience("rp-web-client")
    .setSubject("e2e-subject")
    .setExpirationTime("2m")
    .sign(pair.privateKey);
  try {
    // This literal loopback routing parameter is used ONLY by this hermetic
    // test. The production constructor always uses Docker DNS "traefik".
    const transport = new OidcIssuerTransport(issuer, "traefik", "127.0.0.1");
    const discoveryResp = await transport.fetch(issuer + "/.well-known/openid-configuration", "discovery");
    assert.equal(discoveryResp.status, 200);
    const discovery = await discoveryResp.json();
    assert.equal(discovery.issuer, issuer);
    for (const [path, stage, options] of [
      ["/oauth/v2/token", "code-exchange", { method: "POST", body: "code=test" }],
      ["/oauth/v2/keys", "jwks", {}],
      ["/oidc/v1/userinfo", "userinfo", { headers: { authorization: "Bearer test" } }],
    ]) {
      const response = await transport.fetch(issuer + path, stage, options);
      assert.equal(response.status, 200, path);
    }

    // Crucially, exercise JOSE's actual remote JWK resolver, rather than
    // merely downloading /keys using our transport directly. A valid signed
    // token can only verify if customFetch uses the private HTTPS route.
    const config = { get: (key) => ({
      OIDC_ISSUER_URL: issuer,
      OIDC_PRIVATE_TLS_ROUTE: "traefik",
      OIDC_AUDIENCE: "rp-web-client",
    })[key] };
    const auth = new OidcAuthService(config, {});
    auth.issuerTransport = transport; // Supply the test-only DNS loopback.
    const resolver = await auth.getJwks();
    const verified = await jose.jwtVerify(token, resolver, {
      issuer, audience: "rp-web-client",
    });
    assert.equal(verified.payload.sub, "e2e-subject");

    // The public issuer is deliberately not resolvable in this test.
    await assert.rejects(
      new OidcIssuerTransport(issuer, undefined).fetch(issuer + "/.well-known/openid-configuration", "discovery",
        { signal: AbortSignal.timeout(1500) }),
      (err) => err.status === 503,
    );

    // Same private TCP destination, wrong HTTPS authority: certificate name
    // check MUST fail; we never pass rejectUnauthorized:false.
    await assert.rejects(
      new OidcIssuerTransport(
        `https://wrong.rp-oidc-private.invalid:${server.address().port}`, "traefik", "127.0.0.1",
      ).fetch(`https://wrong.rp-oidc-private.invalid:${server.address().port}/oauth/v2/keys`, "jwks"),
      (err) => err.status === 503,
    );
    process.stdout.write("PASS: public OIDC TLS identity preserved over private TCP route, WAN blackholed\n");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((err) => { process.stderr.write("FAIL: private OIDC TLS proof: " + err.message + "\n"); server.close(); process.exitCode = 1; });
