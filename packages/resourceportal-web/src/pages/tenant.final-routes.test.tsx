import { render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { TenantPage } from "./tenant";
function json(value:unknown){return new Response(JSON.stringify(value),{status:200,headers:{"content-type":"application/json"}})}
it.each([["storage-networking","Storage & Networking"],["access","Access"],["activity","Activity"],["billing","Billing"]])("renders final tenant section %s",async(section,heading)=>{
 vi.stubGlobal("fetch",vi.fn(async()=>json([])));
 render(<TenantPage tenantId="t1" section={section} userId="u1"/>);
 expect(await screen.findByRole("heading",{name:heading})).toBeTruthy();
 expect(screen.queryByText(/Tenant page not found/i)).toBeNull();
});

it.each([["volumes","Create volume"],["registries","Add registry"],["domains","Add domain"]])("uses final storage manager for %s",async(section,action)=>{
 vi.stubGlobal("fetch",vi.fn(async()=>json([])));
 render(<TenantPage tenantId="t1" section={section} userId="u1"/>);
 expect(await screen.findByRole("button",{name:action})).toBeTruthy();
});

it("renders registry detail from the real registry detail endpoint", async () => {
 const registryId="11111111-1111-4111-8111-111111111111";
 const fetchMock=vi.fn(async (input:RequestInfo|URL)=>{
  const url=String(input);
  if(url.endsWith(`/registries/${registryId}`)) return json({id:registryId,name:"Default GHCR",description:"Production images",host:"ghcr.io",tlsMode:"TLS",authType:"Token",hasCredential:true,validationStatus:"Valid",lastValidatedAt:"2026-09-14T08:00:00.000Z",updatedAt:"2026-09-14T08:00:00.000Z"});
  return json([]);
 });
 vi.stubGlobal("fetch",fetchMock);
 render(<TenantPage tenantId="t1" section="registries" resourceId={registryId} userId="u1"/>);
 expect(await screen.findByRole("heading",{name:"Default GHCR"})).toBeTruthy();
 expect(screen.getByText("ghcr.io")).toBeTruthy();
 expect(screen.queryByText(registryId)).toBeNull();
 expect(fetchMock.mock.calls.some(([input])=>String(input).endsWith(`/registries/${registryId}`))).toBe(true);
});

it("renders domain detail from the real domain detail endpoint with friendly assignment", async () => {
 const domainId="22222222-2222-4222-8222-222222222222";
 const fetchMock=vi.fn(async (input:RequestInfo|URL)=>{
  const url=String(input);
  if(url.endsWith(`/domains/${domainId}`)) return json({id:domainId,hostname:"api.resource-portal.pl",type:"Managed",dnsStatus:"Valid",tlsEnabled:true,certificateStatus:"Active",certificateIssuer:"LetsEncrypt",certificateExpiresAt:"2026-12-01T00:00:00.000Z",httpEndpoint:{name:"api",singleAppName:"api",appGroupId:"ag1"},updatedAt:"2026-09-14T08:00:00.000Z"});
  if(url.endsWith("/app-groups")) return json([{id:"ag1",name:"commerce-prod"}]);
  return json([]);
 });
 vi.stubGlobal("fetch",fetchMock);
 render(<TenantPage tenantId="t1" section="domains" resourceId={domainId} userId="u1"/>);
 expect(await screen.findByRole("heading",{name:"api.resource-portal.pl"})).toBeTruthy();
 expect(screen.getByText("commerce-prod / api")).toBeTruthy();
 expect(screen.queryByText(domainId)).toBeNull();
 expect(fetchMock.mock.calls.some(([input])=>String(input).endsWith(`/domains/${domainId}`))).toBe(true);
});

it.each([["administration","Invite user"],["credentials","Create OAuth application"]])("uses final access manager for %s",async(section,action)=>{
 vi.stubGlobal("fetch",vi.fn(async()=>json([])));
 render(<TenantPage tenantId="t1" section={section} userId="u1"/>);
 expect(await screen.findByRole("button",{name:action})).toBeTruthy();
});

it.each([["operations","Operations"],["audit","Audit log"]])("uses final activity page for %s",async(section,heading)=>{
 vi.stubGlobal("fetch",vi.fn(async()=>json([])));
 render(<TenantPage tenantId="t1" section={section} userId="u1"/>);
 expect(await screen.findByRole("heading",{name:heading})).toBeTruthy();
 expect(screen.queryByText(/Resource$/)).toBeNull();
});

it("does not load legacy membership data for a final tenant route", async () => {
 const fetchMock = vi.fn(async (_input: RequestInfo | URL)=>json([]));
 vi.stubGlobal("fetch",fetchMock);
 render(<TenantPage tenantId="t1" section="volumes" userId="u1"/>);
 expect(await screen.findByRole("button",{name:"Create volume"})).toBeTruthy();
 await waitFor(() => expect(fetchMock).toHaveBeenCalled());
 expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/api/tenants/t1/memberships"))).toBe(false);
});

it("routes the Applications import segment to the YAML importer", () => {
 render(<TenantPage tenantId="t1" section="applications" segments={["import"]} userId="u1"/>);
 expect(screen.getByRole("heading", { name: "Import App Group from YAML" })).toBeTruthy();
 expect(screen.getByLabelText("YAML manifest file")).toBeTruthy();
});

it("routes tenant settings to MCP administration", async () => {
 const fetchMock=vi.fn(async (input:RequestInfo|URL)=>{
  const url=String(input);
  if(url.endsWith("/mcp-settings")) return json({enabled:false,accessMode:"SelectedMembers",allowedMembershipIds:[],oauth:{discoveryAvailable:true,dynamicClientRegistrationAvailable:false}});
  return json([]);
 });
 vi.stubGlobal("fetch",fetchMock);
 render(<TenantPage tenantId="t1" section="settings" userId="u1"/>);
 expect(await screen.findByRole("heading",{name:"Tenant settings"})).toBeTruthy();
 expect(screen.getByText("Model Context Protocol (MCP)")).toBeTruthy();
});
