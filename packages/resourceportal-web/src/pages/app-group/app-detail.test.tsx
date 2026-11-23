import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ApplicationDetail } from "./app-detail";
function json(value: unknown){return new Response(JSON.stringify(value),{status:200,headers:{"content-type":"application/json"}})}
it("runs application runtime actions through the application endpoint", async()=>{
 const fetchMock=vi.fn(async(input:RequestInfo|URL)=>{const p=String(input);if(p.endsWith("/single-apps"))return json([{id:"app1",name:"checkout",runtimeState:"Running",effectiveRuntimeState:"Running",health:"Healthy"}]);if(p.endsWith("/runtime-config"))return json({environment:{},secrets:[]});if(p.endsWith("/http-endpoints"))return json([]);if(p.endsWith("/runtime/stop"))return json({});return json([])});vi.stubGlobal("fetch",fetchMock);
 render(<ApplicationDetail tenantId="t1" appGroupId="ag1" appId="app1"/>);
 expect(await screen.findByRole("heading",{name:"checkout",level:1})).toBeTruthy();
 expect(screen.getByRole("main")).toBeTruthy();
 const stop=await screen.findByRole("button",{name:"Stop application"});fireEvent.click(stop);
 await vi.waitFor(()=>expect(fetchMock.mock.calls.some(([p])=>String(p).endsWith("/single-apps/app1/runtime/stop"))).toBe(true));
});


it("shows attached storage and network IP addresses from the application payload", async()=>{
 const fetchMock=vi.fn(async(input:RequestInfo|URL)=>{
  const p=String(input);
  if(p.endsWith("/single-apps"))return json([{
   id:"app1",name:"checkout",runtimeState:"Running",effectiveRuntimeState:"Running",health:"Healthy",
   volumeAttachments:[{id:"va1",mountPath:"/data",mode:"ReadWrite",volume:{id:"v1",name:"orders-data"}}],
   networkAttachments:[{id:"na1",address:"10.20.0.12",network:{id:"n1",name:"private-apps",cidr:"10.20.0.0/24"}}]
  }]);
  if(p.endsWith("/runtime-config"))return json({environment:{},secrets:[]});
  if(p.endsWith("/http-endpoints"))return json([]);
  return json([]);
 });
 vi.stubGlobal("fetch",fetchMock);
 render(<ApplicationDetail tenantId="t1" appGroupId="ag1" appId="app1"/>);
 expect(await screen.findByText("orders-data")).toBeTruthy();
 expect(screen.getByText("/data")).toBeTruthy();
 expect(screen.getByText("private-apps")).toBeTruthy();
 expect(screen.getByText("10.20.0.12")).toBeTruthy();
});

it("shows domain assignments and loads container logs only on the dedicated Logs tab", async () => {
 const fetchMock=vi.fn(async(input:RequestInfo|URL)=>{
  const path=String(input);
  if(path.endsWith("/single-apps"))return json([{id:"app1",name:"checkout",runtimeState:"Running",effectiveRuntimeState:"Running",health:"Healthy",volumeAttachments:[{id:"v1",mode:"ReadOnly",mountPath:"/config",volume:{name:"configuration"}}]}]);
  if(path.endsWith("/runtime-config"))return json({environment:{},secrets:[]});
  if(path.endsWith("/http-endpoints"))return json([{id:"ep1",name:"frontend",containerPort:80,protocolMode:"HTTP_REDIRECT_TO_HTTPS",domains:[{id:"d1",hostname:"app.example.test"}]}]);
  if(path.endsWith("/logs"))return json({lines:["2026-10-10T09:10:00Z started"]});
  return json([]);
 });
 vi.stubGlobal("fetch",fetchMock);
 render(<ApplicationDetail tenantId="t1" appGroupId="ag1" appId="app1"/>);
 expect(await screen.findByText("app.example.test")).toBeTruthy();
 expect(screen.getByText("Read only")).toBeTruthy();
 expect(fetchMock.mock.calls.some(([path])=>String(path).endsWith("/logs"))).toBe(false);

 expect(screen.getByRole("link",{name:"Logs"}).getAttribute("href")).toBe("/tenants/t1/app-groups/ag1/apps/app1/logs");
 expect(screen.queryByText(/2026-10-10T09:10:00Z started/)).toBeNull();
 expect(fetchMock.mock.calls.some(([path])=>String(path).endsWith("/logs"))).toBe(false);
});

it("distinguishes infrastructure unavailability from missing log permissions", async () => {
 const fetchMock = vi.fn(async(input: RequestInfo | URL) => {
  const path = String(input);
  if (path.endsWith("/single-apps")) return json([{id:"app1",name:"checkout",runtimeState:"Running",health:"Healthy"}]);
  if (path.endsWith("/runtime-config")) return json({environment:{},secrets:[]});
  if (path.endsWith("/http-endpoints")) return json([]);
  if (path.endsWith("/logs")) return new Response(JSON.stringify({message:"Container logs are currently unavailable"}),{status:503,headers:{"content-type":"application/json"}});
  return json([]);
 });
 vi.stubGlobal("fetch", fetchMock);
 render(<ApplicationDetail tenantId="t1" appGroupId="ag1" appId="app1" section="logs"/>);
 expect(await screen.findByText(/Your tenant permissions are not the cause/)).toBeTruthy();
});

it("shows human-readable runtime/health on application detail without leaking technical enums", async () => {
 const fetchMock = vi.fn(async(input: RequestInfo | URL) => {
  const path = String(input);
  if(path.endsWith("/single-apps")) return json([{
   id:"app1",name:"scheduled-service",image:"nginx:alpine",
   runtimeState:"PENDING_DEPLOYMENT",effectiveRuntimeState:"PENDING_DEPLOYMENT",
   health:"STARTING_UP",desiredReplicas:1
  }]);
  if(path.endsWith("/runtime-config")) return json({environment:{},secrets:[]});
  if(path.endsWith("/http-endpoints")) return json([]);
  return json([]);
 });
 vi.stubGlobal("fetch",fetchMock);
 render(<ApplicationDetail tenantId="t1" appGroupId="ag1" appId="app1"/>);
 expect(await screen.findByRole("heading",{name:"scheduled-service",level:1})).toBeTruthy();
 expect(screen.getAllByText("Pending deployment").length).toBeGreaterThan(0);
 expect(screen.getByText("Starting up")).toBeTruthy();
 expect(screen.queryByText("PENDING_DEPLOYMENT")).toBeNull();
 expect(screen.queryByText("STARTING_UP")).toBeNull();
});

it("distinguishes runtime-config failure from empty configuration and retries", async () => {
 let runtimeReads = 0;
 const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const path = String(input);
  if (path.endsWith("/single-apps")) return json([{
    id: "app1", name: "checkout", runtimeState: "Running", health: "Healthy",
  }]);
  if (path.endsWith("/runtime-config")) {
    runtimeReads++;
    return runtimeReads === 1
      ? new Response(JSON.stringify({ message: "upstream unavailable" }), {
          status: 503, headers: { "content-type": "application/json" },
        })
      : json({ environment: { SERVICE_MODE: "production" }, secrets: [{ name: "db-password" }] });
  }
  if (path.endsWith("/http-endpoints")) return json([]);
  return json([]);
 });
 vi.stubGlobal("fetch", fetchMock);
 render(<ApplicationDetail tenantId="t1" appGroupId="ag1" appId="app1"/>);
 expect(await screen.findByText("Configuration unavailable")).toBeTruthy();
 expect(screen.getByText(/Counts are unavailable until retry succeeds/)).toBeTruthy();
 expect(screen.queryByText("Environment variables")).toBeNull();
 fireEvent.click(screen.getByRole("button", { name: "Retry configuration" }));
 await waitFor(() => expect(runtimeReads).toBe(2));
 expect(await screen.findByText("Environment variables")).toBeTruthy();
 expect(screen.queryByText("Configuration unavailable")).toBeNull();
});
