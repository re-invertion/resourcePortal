/** Script for Zitadel Action V1: External Authentication / Post Authentication.
 * Runs inside Zitadel after successful external IdP verification, never based
 * on the browser-selected IdP or a historic user identity link.
 */
export function buildFederationActionScript(endpoint: string, secret: string): string {
  const url = new URL(endpoint);
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname ||
      url.username || url.password || url.search || url.hash) {
    throw new Error("Invalid federation action callback URL");
  }
  if (secret.length < 32) throw new Error("Invalid federation action secret");
  return [
    "var rpHttp = require('zitadel/http');",
    "function rpFederationAttest(ctx, api) {",
    "  if (!ctx || !ctx.v1 || ctx.v1.authError !== 'none') return;",
    "  var request = ctx.v1.authRequest;",
    "  var hint = request && request.loginHint;",
    "  if (typeof hint !== 'string' || !/^rp-proof-[A-Za-z0-9_-]{43}$/.test(hint)) return;",
    "  var external = ctx.v1.externalUser;",
    "  var actualProvider = external && external.externalIdpId;",
    "  if (typeof actualProvider !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(actualProvider)) throw 'Missing actual IdP';",
    `  var response = rpHttp.fetch(${JSON.stringify(endpoint)}, {`,
    "    method: 'POST',",
    `    headers: { 'authorization': 'Bearer ' + ${JSON.stringify(secret)}, 'content-type': 'application/json' },`,
    "    body: { nonce: hint.slice(9), providerId: actualProvider }",
    "  });",
    "  if (response.status !== 200) throw 'Federation attestation failed';",
    "}",
  ].join("\n");
}
