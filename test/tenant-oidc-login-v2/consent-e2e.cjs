#!/usr/bin/env node
"use strict";
/**
 * Actual separate Login V2 Next.js frontend E2E; no Login V1 fallback.
 * Disposable Github-hosted only, two synthetic OAuth clients and one human.
 * Distinguish signed-in device consent from backend-only session.link checks.
 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");
const { safeFailureLine } = require("./fail-safe-error.cjs");
let failureStage = "initialization";
const issuer = "https://localhost:8443";
for (const [key,value] of Object.entries({
  GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted",
  RP_LOGIN_V2_E2E_ISOLATED: "true", ZITADEL_VERSION: "v4.19.5",
})) assert.equal(process.env[key], value);
assert.ok(process.env.NODE_EXTRA_CA_CERTS);
const admin = fs.readFileSync(path.resolve(
  __dirname, "../../var/federation/zitadel/admin.pat"), "utf8").trim();
assert.ok(admin.length >= 32 && !/\s/.test(admin));
const headers = { authorization: "Bearer " + admin,
  "content-type": "application/json" };
const deadline = () => AbortSignal.timeout(20_000);

async function api(method, route, body, orgId) {
  const res = await fetch(issuer + route, {
    method, redirect: "error", signal: deadline(),
    headers: { ...headers, ...(orgId ? { "x-zitadel-orgid": orgId } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error("Isolated ZITADEL " + method + " " +
    route.replace(/\/\d{7,}/g, "/[id]") + " HTTP " + res.status);
  return res.json();
}
async function tokenRequest(endpoint, body) {
  const res = await fetch(endpoint, {
    method:"POST", redirect:"error", signal:deadline(),
    headers: { "content-type":"application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  return { status: res.status, body: await res.json() };
}
function b64url(len=32) { return crypto.randomBytes(len).toString("base64url"); }
async function fillSubmit(page, value, selector) {
  const field=page.locator(selector).first();
  if (!await field.isVisible().catch(()=>false)) return false;
  await field.fill(value);
  await page.locator("button[type='submit'], input[type='submit']").first().click();
  return true;
}
async function signInBrowser(page, clientId, userName, password, discovery, callback) {
  const state=b64url(20),nonce=b64url(20),verifier=b64url(32);
  const challenge=crypto.createHash("sha256").update(verifier).digest("base64url");
  const url=new URL(discovery.authorization_endpoint);
  for (const [k,v] of Object.entries({
    client_id:clientId,redirect_uri:callback,response_type:"code",
    scope:"openid profile email offline_access",
    code_challenge_method:"S256",code_challenge:challenge,state,nonce,
  })) url.searchParams.set(k,v);
  await page.goto(url.toString(),{waitUntil:"domcontentloaded",timeout:45000});
  assert.ok(new URL(page.url()).pathname.startsWith("/ui/v2/login"),
    "OIDC browser redirected to Login V1 instead of the required Login V2");

  let nameEntered=false,passwordEntered=false,completeUrl;
  for(let tries=0;tries<90;tries++){
    const current=new URL(page.url());
    if(current.pathname==="/oidc/callback"){
      completeUrl=current;break;
    }
    // Explicitly never treat a legacy /ui/login page as a Login V2 result.
    assert.ok(current.pathname.startsWith("/ui/v2/login"),
      "Login V2 browser exited the required frontend unexpectedly: "+current.pathname);
    if(!nameEntered && await fillSubmit(page,userName,
      'input[name="loginName"], input[name="loginname"], input[name="username"], input[autocomplete="username"], input[type="email"], input[type="text"]')){
      nameEntered=true;continue;
    }
    if(nameEntered && !passwordEntered && await fillSubmit(page,password,
      'input[type="password"]')){
      passwordEntered=true;continue;
    }
    const choosePassword=page.getByRole("button",{name:/use password|continue with password/i}).first();
    if(await choosePassword.isVisible().catch(()=>false)){
      await choosePassword.click();continue;
    }
    // OIDC client code consent is separate from Device Code consent.
    if(passwordEntered && current.pathname.includes("consent")){
      const approve=page.getByRole("button",{name:/allow|approve|confirm/i}).first();
      if(await approve.isVisible().catch(()=>false)){await approve.click();continue;}
    }
    await page.waitForTimeout(450);
  }
  assert.ok(completeUrl,"Isolated Login V2 browser never completed the PKCE callback; last path: "+
    new URL(page.url()).pathname);
  assert.equal(completeUrl.searchParams.get("state"),state);
  const code=completeUrl.searchParams.get("code");
  assert.ok(code,"No authorization code from real Login V2 PKCE");
  const exchange=await tokenRequest(discovery.token_endpoint,{
    grant_type:"authorization_code",client_id:clientId,
    code,redirect_uri:callback,code_verifier:verifier,
  });
  assert.equal(exchange.status,200,"Real Login V2 PKCE token exchange failed");
  assert.ok(exchange.body.id_token && exchange.body.access_token);
  const {createRemoteJWKSet,jwtVerify}=await import("jose");
  const verified=await jwtVerify(exchange.body.id_token,
    createRemoteJWKSet(new URL(discovery.jwks_uri)),
    {issuer,audience:clientId});
  assert.equal(verified.payload.nonce,nonce);
  return verified.payload.sub;
}
// RFC8628 per-device minimum interval; slow_down adds five seconds.
const devicePolls=new Map();
async function deviceToken(discovery,clientId,deviceCode) {
  const schedule=devicePolls.get(deviceCode);
  assert.ok(schedule,"Missing issued Device Code polling metadata");
  // Use monotonic time and schedule from response completion, not request
  // dispatch. Include a small margin for provider/network clock granularity.
  // Never poll earlier than the advertised RFC8628 interval.
  const remaining=schedule.nextAt-performance.now();
  if(remaining>0) await new Promise(resolve=>setTimeout(resolve,Math.ceil(remaining)));
  const result=await tokenRequest(discovery.token_endpoint,{
    grant_type:"urn:ietf:params:oauth:grant-type:device_code",
    client_id:clientId,device_code:deviceCode,
  });
  if(result.body.error==="slow_down") schedule.intervalMs+=5000;
  schedule.nextAt=performance.now()+schedule.intervalMs+250;
  return result;
}
async function deviceRequest(discovery,clientId) {
  const r=await fetch(discovery.device_authorization_endpoint,{
    method:"POST",redirect:"error",signal:deadline(),
    headers:{"content-type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({client_id:clientId,scope:"openid profile"}),
  });
  assert.equal(r.status,200,"Real Login V2 Device Authorization app refused request");
  const info=await r.json();
  assert.ok(info.device_code && info.user_code && info.verification_uri_complete);
  assert.equal(new URL(info.verification_uri_complete).origin,issuer);
  const interval=info.interval===undefined?5:Number(info.interval);
  assert.ok(Number.isSafeInteger(interval)&&interval>0);
  devicePolls.set(info.device_code,{intervalMs:interval*1000,
    nextAt:performance.now()+interval*1000+250});
  return info;
}
async function assertPending(discovery,clientId,code) {
  const r=await deviceToken(discovery,clientId,code);
  assert.equal(r.status,400,"SECURITY: unapproved Login V2 device request issued tokens");
  assert.ok(["authorization_pending","slow_down"].includes(r.body.error),
    "Device request was not pending without explicit consent");
  assert.ok(!r.body.access_token&&!r.body.id_token&&!r.body.refresh_token,
    "SECURITY: OAuth tokens issued without explicit Login V2 device consent");
}
// Paths and data-testid values are the actual pinned v4.19.5 Login V2
// component contract. Never construct a consent URL or approve through API.
const devicePath="/ui/v2/login/device";
const accountsPath="/ui/v2/login/accounts";
const consentPath="/ui/v2/login/device/consent";
const signedInPath="/ui/v2/login/signedin";

function atRoute(page, path) {
  const url=new URL(page.url());
  return url.origin===issuer && url.pathname===path;
}
async function waitForRoute(page, paths, timeout=30000) {
  await page.waitForURL(url=>url.origin===issuer && paths.includes(url.pathname),
    {waitUntil:"domcontentloaded",timeout});
}

/**
 * Use the code-entry form and the actual signed-in account button exactly
 * once per screen. Next.js transitions may update URL before DOM or leave
 * the old button attached briefly. Waiting for the next exact route after
 * each single click prevents accidentally submitting a stale screen twice.
 */
async function reachDeviceConsent(page, request, username, scenario) {
  failureStage="device-"+scenario+"-entry";
  await page.goto(request.verification_uri_complete,{
    waitUntil:"domcontentloaded",timeout:45000,
  });
  await waitForRoute(page,[devicePath,accountsPath,consentPath]);
  if (atRoute(page,devicePath)) {
    failureStage="device-"+scenario+"-code-form";
    const field=page.getByTestId("code-text-input");
    const submit=page.getByTestId("submit-button");
    await field.waitFor({state:"visible",timeout:15000});
    assert.ok(typeof request.user_code==="string" && /^[A-Za-z0-9-]+$/.test(request.user_code));
    // Synchronize React form state with the actual issued code, using the
    // pinned UI's named text field, never an arbitrary first input.
    await field.fill("");
    await field.fill(request.user_code);
    await field.press("Tab");
    assert.ok(atRoute(page,devicePath),"Code-entry route changed unexpectedly");
    await submit.click({timeout:20000});
    await waitForRoute(page,[accountsPath,consentPath]);
  }
  if (atRoute(page,accountsPath)) {
    failureStage="device-"+scenario+"-account";
    const account=page.getByRole("button",{name:new RegExp(username)});
    await account.waitFor({state:"visible",timeout:15000});
    assert.ok(atRoute(page,accountsPath),"Account picker route changed unexpectedly");
    await account.click({timeout:15000});
    await waitForRoute(page,[consentPath]);
  }
  failureStage="device-"+scenario+"-controls";
  assert.ok(atRoute(page,consentPath),"Real authenticated consent route not reached");
  const shown=page.getByTestId("user-code");
  const allow=page.getByTestId("submit-button");
  const deny=page.getByTestId("deny-button");
  await shown.waitFor({state:"visible",timeout:15000});
  // Assert the displayed RFC8628 user code belongs to THIS request; a
  // previous consent page or stale SPA response cannot satisfy the test.
  assert.equal((await shown.textContent())?.trim(),request.user_code);
  await allow.waitFor({state:"visible",timeout:15000});
  await deny.waitFor({state:"visible",timeout:15000});
  assert.ok(await allow.isEnabled() && await deny.isEnabled(),"Consent controls unavailable");
  return {allow,deny};
}

function assertNoDeviceTokens(result) {
  assert.ok(!result.body.access_token&&!result.body.id_token&&!result.body.refresh_token,
    "SECURITY: unexpected device token returned");
}
async function awaitDeviceDecision(discovery,clientId,deviceCode,decision) {
  // Permit only bounded legitimate propagation/poll pacing states. Never
  // retry the UI decision, accept invalid_grant, or treat a denial as Allow.
  for(let attempt=0;attempt<6;attempt++){
    const result=await deviceToken(discovery,clientId,deviceCode);
    if(decision==="allow" && result.status===200) return result.body;
    assert.equal(result.status,400,"Unexpected device token HTTP status");
    assertNoDeviceTokens(result);
    if(decision==="deny" && result.body.error==="access_denied") return;
    assert.ok(["authorization_pending","slow_down"].includes(result.body.error),
      "Unexpected terminal OAuth device state");
  }
  throw new Error("Explicit device decision did not settle within bounded polls");
}

(async () => {
  failureStage = "issuer-discovery";
  const discoveryResponse=await fetch(issuer+"/.well-known/openid-configuration",{
    redirect:"error",signal:deadline(),
  });
  assert.equal(discoveryResponse.status,200);
  const discovery=await discoveryResponse.json();
  assert.equal(discovery.issuer,issuer);
  failureStage = "synthetic-fixtures";
  const org=await api("GET","/admin/v1/orgs/default");
  const orgId=org.org?.id;
  assert.ok(orgId && /^\d+$/.test(orgId));
  const label=crypto.randomUUID().slice(0,12);
  const project=await api("POST","/management/v1/projects",{
    name:"rp532-login-v2-"+label,
    projectRoleAssertion:true,projectRoleCheck:true,hasProjectCheck:true,
    privateLabelingSetting:"PRIVATE_LABELING_SETTING_UNSPECIFIED",
  },orgId);
  assert.ok(project.id);
  const projId=project.id;
  await api("POST","/management/v1/projects/"+projId+"/roles",{
    roleKey:"rp.tenant.member",displayName:"Tenant Member",group:"",
  },orgId);
  const username="rp532v2-"+label,password="Test!aA1-"+b64url(18);
  const user=await api("POST","/management/v1/users/human/_import",{
    userName:username,
    profile:{firstName:"Login",lastName:"V2",displayName:"Login V2 E2E",
      preferredLanguage:"en"},
    email:{email:"rp532-"+label+"@example.test",isEmailVerified:true},
    password,passwordChangeRequired:false,
  },orgId);
  assert.ok(user.userId);
  const grant=await api("POST","/management/v1/users/"+user.userId+"/grants",{
    projectId:projId,roleKeys:["rp.tenant.member"],
  },orgId);
  assert.ok(grant.userGrantId);
  const createApp=async(name,device,redirectUris=[])=>{
    const app=await api("POST","/management/v1/projects/"+projId+"/apps/oidc",{
      name,
      redirectUris,
      responseTypes:["OIDC_RESPONSE_TYPE_CODE"],
      grantTypes:device?["OIDC_GRANT_TYPE_DEVICE_CODE"]:
        ["OIDC_GRANT_TYPE_AUTHORIZATION_CODE","OIDC_GRANT_TYPE_REFRESH_TOKEN"],
      appType:"OIDC_APP_TYPE_NATIVE",
      authMethodType:"OIDC_AUTH_METHOD_TYPE_NONE",
      postLogoutRedirectUris:[],
      version:"OIDC_VERSION_1_0",devMode:false,
      accessTokenType:"OIDC_TOKEN_TYPE_JWT",idTokenUserinfoAssertion:true,
    },orgId);
    assert.ok(app.appId&&app.clientId);
    return app.clientId;
  };
  const callback="http://127.0.0.1:8767/oidc/callback";
  const browserClientId=await createApp("Login V2 Session "+label,false,[callback]);
  const deviceClientId=await createApp("Login V2 Device Consent "+label,true);
  const listener=http.createServer((req,res)=>{
    const callbackUrl=new URL(req.url??"/",callback);
    res.writeHead(callbackUrl.pathname==="/oidc/callback"?200:404,
      {"content-type":"text/plain; charset=utf-8"});
    res.end("Isolated V2 authorization callback");
  });
  await new Promise((resolve,reject)=>{
    listener.once("error",reject);listener.listen(8767,"127.0.0.1",resolve);
  });
  const browser=await chromium.launch({headless:true});
  const context=await browser.newContext({ignoreHTTPSErrors:true});
  const page=await context.newPage();
  try {
    failureStage = "login-v2-pkce";
    const sub=await signInBrowser(page,browserClientId,username,password,discovery,callback);
    assert.equal(sub,user.userId,"Login V2 used wrong synthetic subject");
    const cookies=await context.cookies(issuer);
    assert.ok(cookies.length>0,"Successful Login V2 has no issuer browser session");
    console.log("PASS: genuine isolated Login V2 browser/password and signed Native PKCE session");
    failureStage = "device-deny-request";
    const request=await deviceRequest(discovery,deviceClientId);
    failureStage = "device-deny-initial-pending";
    await assertPending(discovery,deviceClientId,request.device_code);
    // Use a fresh page for each device journey, retaining the same authenticated
    // browser context and provider-owned cookies; no manual cookie changes.
    const denyPage=await context.newPage();
    try {
      const {deny}=await reachDeviceConsent(denyPage,request,username,"deny");
      failureStage = "device-deny-visible-pending";
      await assertPending(discovery,deviceClientId,request.device_code);
      await denyPage.waitForTimeout(6_000);
      failureStage = "device-deny-dwell-pending";
      await assertPending(discovery,deviceClientId,request.device_code);
      console.log("PASS: signed-in Login V2 Device consent screen visible; NO implicit approval or token on page view");
      failureStage = "device-deny-decision";
      await deny.click({timeout:15000});
      // The pinned frontend deletes its deviceCodeCheck cookie and returns
      // to code entry only after the actual denial server action succeeds.
      await waitForRoute(denyPage,[devicePath]);
      failureStage = "device-deny-token-poll";
      await awaitDeviceDecision(discovery,deviceClientId,request.device_code,"deny");
      console.log("PASS: explicit Login V2 Deny rejects the original device code");
    } finally { await denyPage.close(); }

    // Positive control on a fresh code with the same signed-in browser
    // context. No administrative approval, silent consent or weakened JWT.
    failureStage = "device-allow-request";
    const positive=await deviceRequest(discovery,deviceClientId);
    failureStage = "device-allow-initial-pending";
    await assertPending(discovery,deviceClientId,positive.device_code);
    const allowPage=await context.newPage();
    let approved;
    try {
      const {allow}=await reachDeviceConsent(allowPage,positive,username,"allow");
      failureStage = "device-allow-pending";
      await assertPending(discovery,deviceClientId,positive.device_code);
      failureStage = "device-allow-decision";
      await allow.click({timeout:15000});
      // The pinned Login V2 approval action routes to signedin only after
      // successful explicit provider authorization; fail on a login loop.
      await waitForRoute(allowPage,[signedInPath]);
      failureStage = "device-allow-token-poll";
      approved=await awaitDeviceDecision(discovery,deviceClientId,positive.device_code,"allow");
      assert.ok(approved?.access_token && approved?.id_token,
        "Real Login V2 Allow did not issue OAuth Device ID/access tokens");
    } finally { await allowPage.close(); }
    failureStage = "device-allow-token-verify";
    assert.equal(approved.token_type?.toLowerCase(),"bearer");
    const { createRemoteJWKSet,jwtVerify }=await import("jose");
    const keyset=createRemoteJWKSet(new URL(discovery.jwks_uri));
    const signedId=await jwtVerify(approved.id_token,keyset,{
      issuer,audience:deviceClientId,
    });
    assert.equal(signedId.payload.sub,user.userId,
      "Approved device ID token subject does not match the consented user");
    const signedAccess=await jwtVerify(approved.access_token,keyset,{issuer});
    assert.equal(signedAccess.payload.sub,user.userId);
    console.log("PASS: explicit Login V2 Allow authorizes a fresh device code with signed ID/access JWT for the actual consented synthetic user");

  } finally {
    await context.close();await browser.close();
    await new Promise(resolve=>listener.close(resolve));
  }
})().catch(error=>{
  // Never print passwords, tokens, authorization codes, device codes or URLs.
  console.error(safeFailureLine(failureStage,error));
  process.exitCode=1;
});
