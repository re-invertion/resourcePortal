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
  const remaining=schedule.nextAt-Date.now();
  if(remaining>0) await new Promise(resolve=>setTimeout(resolve,remaining));
  const started=Date.now();
  const result=await tokenRequest(discovery.token_endpoint,{
    grant_type:"urn:ietf:params:oauth:grant-type:device_code",
    client_id:clientId,device_code:deviceCode,
  });
  if(result.body.error==="slow_down") schedule.intervalMs+=5000;
  schedule.nextAt=started+schedule.intervalMs;
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
  devicePolls.set(info.device_code,{intervalMs:interval*1000,nextAt:0});
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
/**
 * Advance ONLY the Login V2 Device *code-entry* form, not a consent UI.
 * Verification URI may prefill the code before NextJS hydration; explicitly
 * fill a real code input to synchronize React state and wait for an enabled
 * Continue button. Never log user_code or manipulate Allow/Deny here.
 */
async function advanceDeviceCodeEntry(page, code) {
  assert.equal(new URL(page.url()).pathname, "/ui/v2/login/device");
  assert.ok(code && /^[A-Za-z0-9-]+$/.test(code));
  // The asynchronous Login V2 client may automatically navigate from
  // device code entry to account selection before Playwright clicks. That
  // transition is NOT consent: the outer loop must still reach consent,
  // verify pending state and explicitly click Deny/Allow.
  const movedToNextScreen = () => {
    const uri = new URL(page.url());
    assert.equal(uri.origin, issuer);
    if (uri.pathname === "/ui/v2/login/device") return false;
    assert.ok(uri.pathname.startsWith("/ui/v2/login/"),
      "Device verification navigated outside the real Login V2 frontend");
    return true;
  };
  // Wait for the Next.js client component to hydrate. A field populated
  // from the verification_uri before hydration looks filled but its React
  // form state has not yet validated the code (Continue remains disabled).
  await page.waitForTimeout(750);
  if (movedToNextScreen()) return;
  const entry = page.locator([
    'input[name*="code" i]',
    'input[id*="code" i]',
    'input[autocomplete="one-time-code"]',
    'input[type="text"]',
    'input:not([type])',
  ].join(", ")).first();
  if (await entry.count() && await entry.isVisible().catch(() => false)) {
    // Some Login V2 versions prefill the code in HTML without hydrating the
    // controlled React field. Replace, don't rely on untrusted prefill state.
    await entry.fill("");
    await entry.fill(code);
    await entry.press("Tab");
  } else {
    // If the form is split into one-character inputs, enter only the actual
    // synthetic code characters. All other layouts fail closed below.
    const digits = page.locator('input[maxlength="1"]');
    const plain = code.replace(/-/g, "");
    if (await digits.count() === plain.length) {
      for (let i=0;i<plain.length;i++) await digits.nth(i).fill(plain[i]);
    }
  }
  if (movedToNextScreen()) return;
  const next = page.getByRole("button",{name:/^(continue|verify|next)$/i}).first();
  let enabled = false;
  // The provider validates a real user_code asynchronously; never force-click
  // a disabled control or count a static form as valid device authorization.
  for (let attempt=0;attempt<40;attempt++) {
    if (movedToNextScreen()) return;
    const visible = await next.isVisible().catch(() => false);
    enabled = visible && await next.isEnabled().catch(() => false);
    if (enabled) break;
    await page.waitForTimeout(250);
  }
  if (!enabled) {
    const shape = await page.locator("input").evaluateAll(elements =>
      elements.slice(0,12).map(e => ({
        name:e.getAttribute("name"),type:e.getAttribute("type"),
        id:e.getAttribute("id"),disabled:e.disabled,
        length:e.value?.length??0,
      })));
    throw Error("Login V2 device code entry has no enabled Continue; inputs shape: "+
      JSON.stringify(shape));
  }
  if (movedToNextScreen()) return;
  await next.click({ timeout: 5_000 });
  // No consent decision here. The next loop explicitly requires the real
  // device consent screen and two separate Allow/Deny buttons.
}
(async () => {
  const discoveryResponse=await fetch(issuer+"/.well-known/openid-configuration",{
    redirect:"error",signal:deadline(),
  });
  assert.equal(discoveryResponse.status,200);
  const discovery=await discoveryResponse.json();
  assert.equal(discovery.issuer,issuer);
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
    const sub=await signInBrowser(page,browserClientId,username,password,discovery,callback);
    assert.equal(sub,user.userId,"Login V2 used wrong synthetic subject");
    const cookies=await context.cookies(issuer);
    assert.ok(cookies.length>0,"Successful Login V2 has no issuer browser session");
    console.log("PASS: genuine isolated Login V2 browser/password and signed Native PKCE session");
    const request=await deviceRequest(discovery,deviceClientId);
    await assertPending(discovery,deviceClientId,request.device_code);
    await page.goto(request.verification_uri_complete,{
      waitUntil:"domcontentloaded",timeout:45000,
    });
    for(let attempt=0;attempt<40;attempt++){
      const current=new URL(page.url());
      assert.equal(current.origin,issuer);
      if(current.pathname.includes("/device/consent"))break;
      // The actual Login V2 /device page requires Continue to submit the
      // pre-filled user_code, *before* any account selection/consent page.
      // Never click Allow here; only advance the code-entry state.
      if(current.pathname==="/ui/v2/login/device"){
        await advanceDeviceCodeEntry(page,request.user_code);continue;
      }
      if(current.pathname.includes("/accounts")){
        const account=page.getByText(username,{exact:false}).first();
        if(await account.isVisible().catch(()=>false)){
          await account.click();continue;
        }
        const continueBtn=page.getByRole("button",{name:/continue/i}).first();
        if(await continueBtn.isVisible().catch(()=>false)){
          await continueBtn.click();continue;
        }
      }
      await page.waitForTimeout(350);
    }
    assert.ok(new URL(page.url()).pathname.includes("/ui/v2/login/device/consent"),
      "Real Login V2 device consent screen not reached: "+
      new URL(page.url()).pathname);
    const allow=page.getByRole("button",{name:/^allow$|^approve$/i}).first();
    const deny=page.getByRole("button",{name:/^deny$|^reject$/i}).first();
    assert.ok(await allow.isVisible().catch(()=>false),
      "Real Login V2 consent page does not expose explicit Allow");
    assert.ok(await deny.isVisible().catch(()=>false),
      "Real Login V2 consent page does not expose explicit Deny");
    await assertPending(discovery,deviceClientId,request.device_code);
    await page.waitForTimeout(6_000);
    await assertPending(discovery,deviceClientId,request.device_code);
    console.log("PASS: signed-in Login V2 Device consent screen visible; NO implicit approval or token on page view");
    await deny.click();
    const rejected=await deviceToken(discovery,deviceClientId,request.device_code);
    assert.equal(rejected.status,400);
    assert.equal(rejected.body.error,"access_denied",
      "Explicit Login V2 Deny did not reject device authorization");
    console.log("PASS: explicit Login V2 Deny rejects the original device code");

    // Positive control on a *fresh* device code and this same authenticated
    // browser. Missing Login Client permissions, broken consent UI or broken
    // device token issuance MUST fail the test, not count as safe denial.
    const positive=await deviceRequest(discovery,deviceClientId);
    await assertPending(discovery,deviceClientId,positive.device_code);
    await page.goto(positive.verification_uri_complete,{
      waitUntil:"domcontentloaded",timeout:45000,
    });
    for(let attempt=0;attempt<40;attempt++){
      const url=new URL(page.url());
      assert.equal(url.origin,issuer);
      if(url.pathname.includes("/ui/v2/login/device/consent"))break;
      if(url.pathname==="/ui/v2/login/device"){
        await advanceDeviceCodeEntry(page,positive.user_code);continue;
      }
      if(url.pathname.includes("/accounts")){
        const account=page.getByText(username,{exact:false}).first();
        if(await account.isVisible().catch(()=>false)){
          await account.click();continue;
        }
        const continueButton=page.getByRole("button",{name:/continue/i}).first();
        if(await continueButton.isVisible().catch(()=>false)){
          await continueButton.click();continue;
        }
      }
      await page.waitForTimeout(350);
    }
    assert.ok(new URL(page.url()).pathname.includes("/ui/v2/login/device/consent"),
      "Second real Login V2 device consent page not reached");
    const approve=page.getByRole("button",{name:/^allow$|^approve$/i}).first();
    assert.ok(await approve.isVisible().catch(()=>false),
      "Valid user cannot see the explicit Allow decision");
    // One explicit UI click, never via API admin PAT; do not auto-approve.
    await approve.click();
    let approved;
    for(let attempt=0;attempt<5;attempt++){
      const result=await deviceToken(discovery,deviceClientId,positive.device_code);
      if(result.status===200){approved=result.body;break;}
      assert.equal(result.status,400,
        "Valid consent device exchange returned unexpected token HTTP status");
      assert.ok(["authorization_pending","slow_down"].includes(result.body.error),
        "Valid consent returned invalid OAuth state");
    }
    assert.ok(approved?.access_token && approved?.id_token,
      "Real Login V2 Allow did not issue OAuth Device ID/access tokens");
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
  console.error("BLOCKED: real isolated Login V2 consent E2E: "+
    String(error.message).slice(0,240));
  process.exitCode=1;
});
