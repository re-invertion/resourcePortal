#!/usr/bin/env node
"use strict";
// Loopback HTTPS router: actual API at :8080, real separate Login V2 at :3000.
// Hardcoded disposable origin and upstreams; never forward to external hosts.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
assert.equal(process.env.RP_LOGIN_V2_E2E_ISOLATED, "true");
assert.equal(process.env.ZITADEL_VERSION, "v4.19.5");
const dir = path.join(__dirname, "../var/federation/zitadel/tls");
const server = https.createServer({
  key: fs.readFileSync(path.join(dir, "issuer.key")),
  cert: fs.readFileSync(path.join(dir, "issuer.crt")),
}, (req, res) => {
  const pathAndQuery = req.url ?? "/";
  if (!pathAndQuery.startsWith("/") || req.headers.host !== "localhost:8443") {
    res.writeHead(400); res.end(); return;
  }
  const isLogin = pathAndQuery === "/ui/v2/login" ||
    pathAndQuery.startsWith("/ui/v2/login/");
  const upstream = http.request({
    hostname: "127.0.0.1",
    port: isLogin ? 3000 : 8080,
    method: req.method,
    path: pathAndQuery,
    headers: { ...req.headers, host: "localhost:8443",
      "x-forwarded-host": "localhost:8443",
      "x-forwarded-proto": "https" },
    timeout: 20_000,
  }, response => {
    res.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(res);
  });
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  upstream.on("timeout", () => upstream.destroy());
  req.on("aborted", () => upstream.destroy());
  req.pipe(upstream);
});
server.listen(8443, "127.0.0.1", () =>
  console.log("Disposable Login V2 HTTPS router listening on loopback only"));
process.on("SIGTERM", () => server.close());
process.on("SIGINT", () => server.close());
