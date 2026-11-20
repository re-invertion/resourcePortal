import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TenantDomainDetailPage } from "./tenant-storage-pages";

function json(data: unknown) { return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } }); }
afterEach(() => vi.unstubAllGlobals());

it("#399 links a domain detail assignment to its same-tenant application without writes", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/domains/d1")) return json({
      id: "d1", hostname: "api.example.test", type: "Managed",
      dnsStatus: "Valid", tlsEnabled: true, certificateStatus: "Active",
      httpEndpoint: { id: "e1", name: "web", singleAppId: "a1",
        singleAppName: "frontend", appGroupId: "g1" },
    });
    if (path.endsWith("/app-groups")) return json([{ id: "g1", name: "production" }]);
    return json([]);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<TenantDomainDetailPage tenantId="t1" domainId="d1" />);
  const group = await screen.findByRole("link", { name: "production" });
  expect(group.getAttribute("href")).toBe("/tenants/t1/app-groups/g1");
  const app = screen.getByRole("link", { name: "frontend" });
  expect(app.getAttribute("href")).toBe("/tenants/t1/app-groups/g1/apps/a1");
  expect(fetchMock.mock.calls.every(([, options]) => !options?.method || options.method === "GET")).toBe(true);
});

it("#399 labels HTTP endpoint protocol choices without changing assigned enum or saving", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/domains/d1")) return json({
      id: "d1", hostname: "demo.example.test", type: "Managed",
      dnsStatus: "Valid", tlsEnabled: true, httpEndpoint: null,
    });
    if (path.endsWith("/app-groups")) return json([{ id: "g1", name: "production" }]);
    if (path.endsWith("/app-groups/g1/single-apps")) return json([{ id: "a1", name: "frontend" }]);
    if (path.endsWith("/app-groups/g1/single-apps/a1/http-endpoints")) return json([
      { id: "e1", name: "http", containerPort: 8080, protocolMode: "HTTP" },
      { id: "e2", name: "secure", containerPort: 8443, protocolMode: "HTTPS" },
      { id: "e3", name: "dual", containerPort: 9000, protocolMode: "HTTP_AND_HTTPS" },
      { id: "e4", name: "redirect", containerPort: 8081, protocolMode: "HTTP_REDIRECT_TO_HTTPS" },
    ]);
    return json([]);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<TenantDomainDetailPage tenantId="t1" domainId="d1" />);
  fireEvent.change(await screen.findByRole("combobox", { name: "Assign App Group" }), {
    target: { value: "g1" },
  });
  fireEvent.change(await screen.findByRole("combobox", { name: "Assign application" }), {
    target: { value: "a1" },
  });
  const endpoint = await screen.findByRole("combobox", { name: "Assign HTTP endpoint" });
  await waitFor(() => expect(endpoint.querySelectorAll("option")).toHaveLength(5));
  const choices = Array.from(endpoint.querySelectorAll("option")).slice(1);
  expect(choices.map(option => option.value)).toEqual(["e1", "e2", "e3", "e4"]);
  expect(choices.map(option => option.textContent)).toEqual([
    "http · port 8080 · HTTP only",
    "secure · port 8443 · HTTPS only",
    "dual · port 9000 · HTTP + HTTPS",
    "redirect · port 8081 · HTTP → HTTPS redirect",
  ]);
  expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
});

it("discovers app and endpoint from an unassigned domain and requires confirmation before PATCH", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/domains/d1")) {
      return json({ id: "d1", hostname: "demo.example.test", type: "Managed", dnsStatus: "Valid", tlsEnabled: true, httpEndpoint: null });
    }
    if (path.endsWith("/app-groups")) return json([{ id: "g1", name: "production" }]);
    if (path.endsWith("/app-groups/g1/single-apps")) return json([{ id: "a1", name: "frontend" }]);
    if (path.endsWith("/app-groups/g1/single-apps/a1/http-endpoints")) return json([{ id: "e1", name: "http", containerPort: 8080 }]);
    return json([]);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<TenantDomainDetailPage tenantId="t1" domainId="d1" />);
  expect(await screen.findByRole("heading", { name: "Assign to an application" })).toBeTruthy();
  fireEvent.change(screen.getByRole("combobox", { name: "Assign App Group" }), { target: { value: "g1" } });
  fireEvent.change(await screen.findByRole("combobox", { name: "Assign application" }), { target: { value: "a1" } });
  await screen.findByRole("option", { name: /http.*port 8080/ });
  fireEvent.change(screen.getByRole("combobox", { name: "Assign HTTP endpoint" }), { target: { value: "e1" } });
  fireEvent.click(screen.getByRole("button", { name: "Assign to endpoint" }));
  expect(screen.getByRole("dialog", { name: "Confirm domain assignment" })).toBeTruthy();
  expect(fetchMock.mock.calls.filter(([_, options]) => (options as RequestInit | undefined)?.method === "PATCH")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Assign domain" }));
  await waitFor(() => {
    const patch = fetchMock.mock.calls.find(([url, opts]) => String(url).endsWith("/domains/d1") && (opts as RequestInit | undefined)?.method === "PATCH");
    expect(JSON.parse(String((patch?.[1] as RequestInit | undefined)?.body))).toEqual({ httpEndpointId: "e1" });
  });
});

it("#394 links a legacy custom hostname only to an explicitly selected verified root, preserving other domain settings", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/domains/d1")) return json({
      id: "d1", tenantId: "t1", type: "Custom", hostname: "photos.example.com",
      customRootDomainId: null, dnsStatus: "Valid", certificateStatus: "Active",
      publication: { eligible: false, reason: "VerifiedRootLinkMissing" },
      tlsEnabled: true, httpEndpoint: { id: "e1", name: "web", containerPort: 8080 },
    });
    if (path.endsWith("/domains/custom-root-domains")) return json([
      { id: "root-v", rootDomain: "example.com", verificationStatus: "Verified" },
      { id: "root-pending", rootDomain: "pending.example.com", verificationStatus: "Pending" },
      { id: "root-other", rootDomain: "unrelated.net", verificationStatus: "Verified" },
    ]);
    return json([]);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<TenantDomainDetailPage tenantId="t1" domainId="d1" />);
  expect(await screen.findByRole("heading", { name: "Link verified custom root" })).toBeTruthy();
  expect(screen.getByText(/verified root link missing/i)).toBeTruthy();
  const choice = screen.getByRole("combobox", { name: "Verified custom root" });
  expect(choice.querySelectorAll("option")).toHaveLength(2);
  expect(screen.getByRole("button", { name: "Link verified root" }).hasAttribute("disabled")).toBe(true);
  fireEvent.change(choice, { target: { value: "root-v" } });
  fireEvent.click(screen.getByRole("button", { name: "Link verified root" }));
  expect(screen.getByRole("dialog", { name: "Confirm verified root link" })).toBeTruthy();
  expect(fetchMock.mock.calls.filter(([, opts]) => (opts as RequestInit | undefined)?.method === "PATCH")).toHaveLength(0);
  const dialog = screen.getByRole("dialog", { name: "Confirm verified root link" });
  const confirm = Array.from(dialog.querySelectorAll("button")).find(b => b.textContent?.trim() === "Link verified root");
  expect(confirm).toBeTruthy();
  fireEvent.click(confirm!);
  await waitFor(() => {
    const patch = fetchMock.mock.calls.find(([url, opts]) => String(url).endsWith("/domains/d1") && (opts as RequestInit | undefined)?.method === "PATCH");
    expect(JSON.parse(String((patch?.[1] as RequestInit | undefined)?.body))).toEqual({ customRootDomainId: "root-v" });
  });
});

it("#394 shows observed DNS mismatch separately from ingress reachability", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith("/domains/d1/dns-diagnostics")) return json({
      hostname: "photos.example.com", status: "Mismatch", expected: {type: "CNAME", target: "edge.example.net"},
      observed: {cname: ["wrong.example.net"], a: ["192.0.2.1"], aaaa: []},
      recommendation: "Set CNAME photos.example.com to edge.example.net, then validate again.",
    });
    if (path.endsWith("/domains/d1")) return json({
      id: "d1", hostname: "photos.example.com", type: "Custom", customRootDomainId: "root1",
      dnsStatus: "Invalid", tlsEnabled: false, publication: {eligible:false,reason:"DnsNotValid"},
    });
    return json([]);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<TenantDomainDetailPage tenantId="t1" domainId="d1" />);
  expect(await screen.findByRole("heading", {name:"Public DNS diagnostics"})).toBeTruthy();
  expect(await screen.findByText("Mismatch")).toBeTruthy();
  expect(screen.getAllByText(/CNAME photos\.example\.com.*edge\.example\.net/).length).toBeGreaterThan(0);
  expect(screen.getByText("wrong.example.net")).toBeTruthy();
  expect(screen.getByText("192.0.2.1")).toBeTruthy();
  expect(screen.getByText(/does not confirm that an application is running/)).toBeTruthy();
});

it("#394 visibly warns that a stopped App Group is excluded from ingress despite valid DNS and TLS", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith("/domains/d1")) return json({
      id: "d1", hostname: "photos.example.com", type: "Custom", customRootDomainId: "root1",
      dnsStatus: "Valid", certificateStatus: "Active", tlsEnabled: true,
      publication: { eligible: true, reason: null },
      ingress: { intentStatus: "AppGroupStopped", observedRouter: "NotChecked", currentDeploymentVersion: 3 },
      httpEndpoint: { id: "e1", name: "web", containerPort: 8080 },
    });
    return json([]);
  }));
  render(<TenantDomainDetailPage tenantId="t1" domainId="d1" />);
  expect(await screen.findByRole("heading", { name: "Ingress deployment status" })).toBeTruthy();
  expect(screen.getByText("AppGroupStopped")).toBeTruthy();
  expect(screen.getByText(/App Group is stopped; the ingress reconciler excludes its routes/)).toBeTruthy();
  expect(screen.getAllByText("Not checked").length).toBeGreaterThan(0);
});


it("#394 deployment preflight shows actionable blockers without claiming live ingress reachability", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path=String(input);
    if (path.endsWith("/domains/d1")) return json({
      id:"d1",hostname:"photos.example.com",type:"Custom",customRootDomainId:"root1",
      dnsStatus:"Invalid",certificateStatus:"Error",tlsEnabled:true,
      publication:{eligible:false,reason:"DnsNotValid"},
      ingress:{intentStatus:"NotEligible",observedRouter:"NotChecked",currentDeploymentVersion:3,
        preflight:{readyForRuntimeInspection:false,deploymentRequired:false,blockers:["DnsNotValid","AppGroupStopped","TlsCertificateError"],liveRouterVerified:false}},
      httpEndpoint:{id:"e1",name:"web",containerPort:8080},
    });
    return json([]);
  }));
  render(<TenantDomainDetailPage tenantId="t1" domainId="d1" />);
  expect(await screen.findByRole("heading", {name:"Ingress deployment status"})).toBeTruthy();
  expect(screen.getByText(/Blocked: DNS must validate; Start the App Group; Resolve the certificate error before deployment/)).toBeTruthy();
  expect(screen.getAllByText("Not checked").length).toBeGreaterThan(0);
  expect(screen.queryByText(/live router verified/i)).toBeNull();
});
