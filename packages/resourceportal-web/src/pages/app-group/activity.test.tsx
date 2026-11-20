import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AppGroupActivity } from "./activity";

const operations = [
  { id: "op-group-a", resourceType: "AppGroup", resourceId: "group-a", type: "APP_GROUP_DEPLOY", status: "Succeeded" },
  { id: "op-app-a", resourceType: "SingleApp", resourceId: "app-a", type: "SINGLE_APP_RESTART", status: "Pending" },
  { id: "op-deploy-a", resourceType: "AppGroupDeployment", resourceId: "deploy-a", type: "APP_GROUP_ROLLBACK", status: "RolledBack" },
  { id: "op-group-b", resourceType: "AppGroup", resourceId: "group-b", type: "APP_GROUP_DELETE", status: "Succeeded" },
  { id: "op-app-b", resourceType: "SingleApp", resourceId: "app-b", type: "SINGLE_APP_STOP", status: "Succeeded" },
  { id: "op-domain-a", resourceType: "Domain", resourceId: "domain-a", type: "DOMAIN_VERIFY", status: "Failed" },
  { id: "op-unscoped", type: "PLATFORM_ACTION", status: "Succeeded" },
];
function json(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}
afterEach(() => vi.unstubAllGlobals());

it("shows only operations belonging to this group and its app/deployment, never an unrelated group, domain or missing association", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/api/tenants/tenant-a/operations") return json(operations);
    if (path === "/api/tenants/tenant-a/app-groups/group-a/single-apps") return json([{ id: "app-a" }]);
    if (path === "/api/tenants/tenant-a/app-groups/group-a/deployments") return json([{ id: "deploy-a" }]);
    return json([]);
  }));
  render(<AppGroupActivity tenantId="tenant-a" appGroupId="group-a" />);
  expect(await screen.findByText("SINGLE APP RESTART")).toBeTruthy();
  expect(screen.getByText("APP GROUP DEPLOY")).toBeTruthy();
  expect(screen.getByText("APP GROUP ROLLBACK")).toBeTruthy();
  expect(screen.queryByText("DOMAIN VERIFY")).toBeNull();
  expect(screen.queryByText("APP GROUP DELETE")).toBeNull();
  expect(screen.queryByText("SINGLE APP STOP")).toBeNull();
  expect(screen.queryByText("PLATFORM ACTION")).toBeNull();
  expect(screen.getByRole("link", { name: /SINGLE APP RESTART/ }).getAttribute("href")).toBe("/tenants/tenant-a/operations/op-app-a");
});

it("fails closed rather than showing whole-tenant operations when relationships cannot load", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith("/operations")) return json(operations);
    if (path.endsWith("/single-apps")) return new Response("error", { status: 503 });
    return json([]);
  }));
  render(<AppGroupActivity tenantId="tenant-a" appGroupId="group-a" />);
  await waitFor(() => expect(screen.getByText("Activity relationships could not be verified")).toBeTruthy());
  expect(screen.queryByText("APP GROUP DEPLOY")).toBeNull();
});

it("#399 refreshes all three App Group activity relationships with tenant-scoped GETs", async () => {
  let operationReads=0;
  const fetchMock=vi.fn(async (input:RequestInfo|URL,init?:RequestInit)=>{
    const path=String(input);
    if(path==="/api/tenants/tenant-a/operations") {
      operationReads++;
      return json([{id:"op-group-a",resourceType:"AppGroup",resourceId:"group-a",type:"APP_GROUP_DEPLOY",status:operationReads===1?"Pending":"Succeeded"}]);
    }
    if(path==="/api/tenants/tenant-a/app-groups/group-a/single-apps")return json([{id:"app-a"}]);
    if(path==="/api/tenants/tenant-a/app-groups/group-a/deployments")return json([{id:"deploy-a"}]);
    throw new Error("Unexpected path "+path);
  });
  vi.stubGlobal("fetch",fetchMock);
  render(<AppGroupActivity tenantId="tenant-a" appGroupId="group-a"/>);
  expect((await screen.findAllByText("Pending")).length).toBeGreaterThan(0);
  expect(screen.getByRole("status").textContent).toContain("Showing 1 of 1 explicitly related operations");
  fireEvent.click(screen.getByRole("button",{name:"Refresh activity"}));
  await waitFor(() => expect(screen.getAllByText("Succeeded").length).toBeGreaterThan(0));
  await waitFor(()=>expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(6));
  expect(operationReads).toBeGreaterThanOrEqual(2);
  expect(fetchMock.mock.calls.every(([url,init])=>String(url).startsWith("/api/tenants/tenant-a/")&&(!init?.method||init.method==="GET"))).toBe(true);
});

it("#399 refuses stale activity when a relationship refresh fails after initial success", async () => {
  let appsReads=0;
  const fetchMock=vi.fn(async (input:RequestInfo|URL,_init?:RequestInit)=>{
    const path=String(input);
    if(path.endsWith("/operations"))return json(operations);
    if(path.endsWith("/single-apps")) {
      if(++appsReads>1)return new Response("relationship error",{status:503});
      return json([{id:"app-a"}]);
    }
    if(path.endsWith("/deployments"))return json([{id:"deploy-a"}]);
    throw new Error("Unexpected path "+path);
  });
  vi.stubGlobal("fetch",fetchMock);
  render(<AppGroupActivity tenantId="tenant-a" appGroupId="group-a"/>);
  expect(await screen.findByText("APP GROUP DEPLOY")).toBeTruthy();
  fireEvent.click(screen.getByRole("button",{name:"Refresh activity"}));
  await waitFor(()=>expect(screen.getByText("Activity relationships could not be verified")).toBeTruthy());
  expect(screen.queryByText("APP GROUP DEPLOY")).toBeNull();
  expect(fetchMock.mock.calls.every(([url,init])=>String(url).startsWith("/api/tenants/tenant-a/")&&(!init?.method||init.method==="GET"))).toBe(true);
});

it("#399 filters only verified App Group activity and clears search and status without writes", async () => {
  const fetchMock=vi.fn(async (input:RequestInfo|URL,init?:RequestInit)=>{
    const path=String(input);
    if(path==="/api/tenants/tenant-a/operations")return json(operations);
    if(path==="/api/tenants/tenant-a/app-groups/group-a/single-apps")return json([{id:"app-a"}]);
    if(path==="/api/tenants/tenant-a/app-groups/group-a/deployments")return json([{id:"deploy-a"}]);
    throw new Error("Unexpected tenant path: "+path);
  });
  vi.stubGlobal("fetch",fetchMock);
  render(<AppGroupActivity tenantId="tenant-a" appGroupId="group-a"/>);
  expect(await screen.findByText("SINGLE APP RESTART")).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("Showing 3 of 3 explicitly related operations");
  expect(screen.queryByText("APP GROUP DELETE")).toBeNull();
  fireEvent.change(screen.getByLabelText("Filter App Group activity status"),{target:{value:"Pending"}});
  expect(screen.getByRole("status").textContent).toContain("Showing 1 of 3");
  expect(screen.getByText("SINGLE APP RESTART")).toBeTruthy();
  expect(screen.queryByText("APP GROUP DEPLOY")).toBeNull();
  fireEvent.change(screen.getByLabelText("Search App Group activity"),{target:{value:"deploy"}});
  expect(screen.getByRole("status").textContent).toContain("Showing 0 of 3");
  expect(screen.queryByText("SINGLE APP RESTART")).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"Clear activity filters"}));
  expect(screen.getByRole("status").textContent).toContain("Showing 3 of 3");
  expect(screen.getByText("APP GROUP ROLLBACK")).toBeTruthy();
  expect(screen.queryByText("APP GROUP DELETE")).toBeNull();
  expect((screen.getByRole("button",{name:"Clear activity filters"}) as HTMLButtonElement).disabled).toBe(true);
  expect(fetchMock.mock.calls).toHaveLength(3);
  expect(fetchMock.mock.calls.every(([url,init])=>String(url).startsWith("/api/tenants/tenant-a/")&&(!init?.method||init.method==="GET"))).toBe(true);
});

it("#399 searches the rendered operation labels with spaces, not only raw underscore keys", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input:RequestInfo|URL)=>{
    const path=String(input);
    if(path.endsWith("/operations"))return json(operations);
    if(path.endsWith("/single-apps"))return json([{id:"app-a"}]);
    if(path.endsWith("/deployments"))return json([{id:"deploy-a"}]);
    throw new Error("Unexpected path "+path);
  }));
  render(<AppGroupActivity tenantId="tenant-a" appGroupId="group-a"/>);
  expect(await screen.findByText("APP GROUP DEPLOY")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Search App Group activity"),{target:{value:"single app restart"}});
  expect(screen.getByText("SINGLE APP RESTART")).toBeTruthy();
  expect(screen.queryByText("APP GROUP DEPLOY")).toBeNull();
  fireEvent.change(screen.getByLabelText("Search App Group activity"),{target:{value:"APP GROUP DEPLOY"}});
  expect(screen.getByText("APP GROUP DEPLOY")).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("Showing 1 of 3");
});

it("#399 retains a selected status option when refreshed activity no longer has matching rows", async () => {
  let reads=0;
  vi.stubGlobal("fetch",vi.fn(async (input:RequestInfo|URL)=>{
    const path=String(input);
    if(path.endsWith("/operations")){
      reads++;
      return json([{id:"op-group-a",resourceType:"AppGroup",resourceId:"group-a",type:"APP_GROUP_DEPLOY",status:reads===1?"Pending":"Succeeded"}]);
    }
    if(path.endsWith("/single-apps")||path.endsWith("/deployments"))return json([]);
    throw new Error("Unexpected path "+path);
  }));
  render(<AppGroupActivity tenantId="tenant-a" appGroupId="group-a"/>);
  expect((await screen.findAllByText("Pending")).length).toBeGreaterThan(0);
  fireEvent.change(screen.getByLabelText("Filter App Group activity status"),{target:{value:"Pending"}});
  fireEvent.click(screen.getByRole("button",{name:"Refresh activity"}));
  await waitFor(()=>expect(screen.getByRole("status").textContent).toContain("Showing 0 of 1"));
  const filter=screen.getByLabelText("Filter App Group activity status") as HTMLSelectElement;
  expect(filter.value).toBe("Pending");
  expect(screen.getByRole("option",{name:"Pending"})).toBeTruthy();
  expect(screen.queryByText("APP GROUP DEPLOY")).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"Clear activity filters"}));
  expect(await screen.findByText("APP GROUP DEPLOY")).toBeTruthy();
});

it("#399 sorts only related loaded operations by timestamp, keeps unknown timestamps last and clears sort without writes", async () => {
  const history = [
    {id:"op-unknown",resourceType:"AppGroup",resourceId:"group-a",type:"APP_GROUP_DEPLOY",status:"Pending"},
    {id:"op-old",resourceType:"AppGroup",resourceId:"group-a",type:"APP_GROUP_DEPLOY",status:"Succeeded",createdAt:"2026-01-01T12:00:00Z"},
    {id:"op-foreign",resourceType:"AppGroup",resourceId:"group-b",type:"APP_GROUP_DELETE",status:"Succeeded",createdAt:"2026-12-01T00:00:00Z"},
    {id:"op-new",resourceType:"AppGroup",resourceId:"group-a",type:"APP_GROUP_ROLLBACK",status:"Succeeded",createdAt:"2026-03-01T12:00:00Z"},
  ];
  const fetchMock=vi.fn(async (input:RequestInfo|URL,init?:RequestInit)=>{
    const path=String(input);
    if(path==="/api/tenants/tenant-a/operations")return json(history);
    if(path==="/api/tenants/tenant-a/app-groups/group-a/single-apps"||path==="/api/tenants/tenant-a/app-groups/group-a/deployments")return json([]);
    throw new Error("Unexpected path "+path);
  });
  vi.stubGlobal("fetch",fetchMock);
  render(<AppGroupActivity tenantId="tenant-a" appGroupId="group-a"/>);
  const order=()=>screen.getAllByRole("link").map(link=>link.getAttribute("href")).filter(href=>href?.startsWith("/tenants/tenant-a/operations/"));
  await waitFor(()=>expect(order()).toHaveLength(3));
  expect(order()).toEqual([
    "/tenants/tenant-a/operations/op-unknown",
    "/tenants/tenant-a/operations/op-old",
    "/tenants/tenant-a/operations/op-new",
  ]);
  fireEvent.change(screen.getByLabelText("Sort App Group activity"),{target:{value:"newest"}});
  expect(order()).toEqual([
    "/tenants/tenant-a/operations/op-new",
    "/tenants/tenant-a/operations/op-old",
    "/tenants/tenant-a/operations/op-unknown",
  ]);
  fireEvent.change(screen.getByLabelText("Sort App Group activity"),{target:{value:"oldest"}});
  expect(order()).toEqual([
    "/tenants/tenant-a/operations/op-old",
    "/tenants/tenant-a/operations/op-new",
    "/tenants/tenant-a/operations/op-unknown",
  ]);
  expect(screen.getByRole("status").textContent).toContain("Showing 3 of 3");
  fireEvent.click(screen.getByRole("button",{name:"Clear activity filters"}));
  expect(order()).toEqual([
    "/tenants/tenant-a/operations/op-unknown",
    "/tenants/tenant-a/operations/op-old",
    "/tenants/tenant-a/operations/op-new",
  ]);
  expect((screen.getByLabelText("Sort App Group activity") as HTMLSelectElement).value).toBe("loaded");
  expect(fetchMock.mock.calls).toHaveLength(3);
  expect(fetchMock.mock.calls.every(([url,init])=>String(url).startsWith("/api/tenants/tenant-a/")&&(!init?.method||init.method==="GET"))).toBe(true);
});

it("#399 UTC activity date window excludes unverified dates, unrelated groups and rejects inverted ranges", async () => {
  const history = [
    {id:"op-a",resourceType:"AppGroup",resourceId:"group-a",type:"APP_GROUP_DEPLOY",status:"Succeeded",createdAt:"2026-04-01T00:00:00Z"},
    {id:"op-b",resourceType:"AppGroup",resourceId:"group-a",type:"APP_GROUP_ROLLBACK",status:"Succeeded",createdAt:"2026-04-02T23:59:59Z"},
    {id:"op-c",resourceType:"AppGroup",resourceId:"group-a",type:"APP_GROUP_DEPLOY",status:"Pending",createdAt:"not-a-date"},
    {id:"op-foreign",resourceType:"AppGroup",resourceId:"group-b",type:"APP_GROUP_DELETE",status:"Failed",createdAt:"2026-04-02T12:00:00Z"},
  ];
  const fetchMock=vi.fn(async (input:RequestInfo|URL,init?:RequestInit)=>{
    const path=String(input);
    if(path==="/api/tenants/tenant-a/operations")return json(history);
    if(path==="/api/tenants/tenant-a/app-groups/group-a/single-apps"||path==="/api/tenants/tenant-a/app-groups/group-a/deployments")return json([]);
    throw new Error("Unexpected tenant path "+path);
  });
  vi.stubGlobal("fetch",fetchMock);
  render(<AppGroupActivity tenantId="tenant-a" appGroupId="group-a"/>);
  await waitFor(()=>expect(screen.getByRole("status").textContent).toContain("Showing 3 of 3"));
  fireEvent.change(screen.getByLabelText("Activity from date"),{target:{value:"2026-04-02"}});
  fireEvent.change(screen.getByLabelText("Activity to date"),{target:{value:"2026-04-02"}});
  expect(screen.getByRole("status").textContent).toContain("Showing 1 of 3");
  expect(screen.getByText("APP GROUP ROLLBACK")).toBeTruthy();
  expect(screen.queryByText("APP GROUP DEPLOY")).toBeNull();
  expect(screen.queryByText("APP GROUP DELETE")).toBeNull();
  fireEvent.change(screen.getByLabelText("Activity from date"),{target:{value:"2026-04-03"}});
  expect(screen.getByRole("alert").textContent).toContain("Invalid activity date range");
  expect(screen.getByRole("status").textContent).toContain("Showing 0 of 3");
  expect(screen.queryByText("APP GROUP ROLLBACK")).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"Clear activity filters"}));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("Showing 3 of 3");
  expect((screen.getByLabelText("Activity from date") as HTMLInputElement).value).toBe("");
  expect((screen.getByLabelText("Activity to date") as HTMLInputElement).value).toBe("");
  expect(fetchMock.mock.calls).toHaveLength(3);
  expect(fetchMock.mock.calls.every(([url,init])=>String(url).startsWith("/api/tenants/tenant-a/")&&(!init?.method||init.method==="GET"))).toBe(true);
});

it("#399 summarizes only verified loaded App Group activity statuses and clears filters without extra requests", async () => {
  const fetchMock=vi.fn(async (input:RequestInfo|URL,init?:RequestInit)=>{
    const path=String(input);
    if(path==="/api/tenants/tenant-a/operations")return json(operations);
    if(path==="/api/tenants/tenant-a/app-groups/group-a/single-apps")return json([{id:"app-a"}]);
    if(path==="/api/tenants/tenant-a/app-groups/group-a/deployments")return json([{id:"deploy-a"}]);
    throw new Error("Unexpected path "+path);
  });
  vi.stubGlobal("fetch",fetchMock);
  render(<AppGroupActivity tenantId="tenant-a" appGroupId="group-a"/>);
  const totals=screen.getByLabelText("Loaded related activity status totals");
  await waitFor(()=>expect(totals.textContent).toContain("Succeeded: 1"));
  expect(totals.textContent).toContain("Pending: 1");
  expect(totals.textContent).toContain("RolledBack: 1");
  expect(totals.textContent).not.toContain("Failed");
  expect(totals.textContent).not.toContain("Succeeded: 4");
  fireEvent.change(screen.getByLabelText("Filter App Group activity status"),{target:{value:"Pending"}});
  expect(screen.getByRole("status").textContent).toContain("Showing 1 of 3");
  expect(totals.textContent).toContain("Succeeded: 1");
  fireEvent.change(screen.getByLabelText("Search App Group activity"),{target:{value:"does-not-match"}});
  expect(screen.getByRole("status").textContent).toContain("Showing 0 of 3");
  expect(totals.textContent).toContain("RolledBack: 1");
  fireEvent.click(screen.getByRole("button",{name:"Clear activity filters"}));
  expect(screen.getByRole("status").textContent).toContain("Showing 3 of 3");
  expect(totals.textContent).toContain("Pending: 1");
  expect(fetchMock.mock.calls).toHaveLength(3);
  expect(fetchMock.mock.calls.every(([url,init])=>String(url).startsWith("/api/tenants/tenant-a/")&&(!init?.method||init.method==="GET"))).toBe(true);
});

it("#399 discloses missing timestamps only for verified related loaded operations and date filters exclude them", async () => {
  const history=[
    {id:"op-undated",resourceType:"AppGroup",resourceId:"group-a",type:"APP_GROUP_DEPLOY",status:"Pending"},
    {id:"op-invalid",resourceType:"AppGroup",resourceId:"group-a",type:"APP_GROUP_ROLLBACK",status:"Failed",createdAt:"not-a-date"},
    {id:"op-dated",resourceType:"AppGroup",resourceId:"group-a",type:"APP_GROUP_DEPLOY",status:"Succeeded",createdAt:"2026-04-01T11:30:00Z"},
    {id:"op-foreign",resourceType:"AppGroup",resourceId:"group-b",type:"APP_GROUP_DELETE",status:"Succeeded"},
  ];
  const fetchMock=vi.fn(async (input:RequestInfo|URL,init?:RequestInit)=>{
    const path=String(input);
    if(path==="/api/tenants/tenant-a/operations")return json(history);
    if(path==="/api/tenants/tenant-a/app-groups/group-a/single-apps"||path==="/api/tenants/tenant-a/app-groups/group-a/deployments")return json([]);
    throw new Error("Unexpected path "+path);
  });
  vi.stubGlobal("fetch",fetchMock);
  render(<AppGroupActivity tenantId="tenant-a" appGroupId="group-a"/>);
  const totals=screen.getByLabelText("Loaded related activity status totals");
  await waitFor(()=>expect(screen.getByRole("status").textContent).toContain("Showing 3 of 3"));
  expect(totals.textContent).toContain("Without valid timestamp: 2 (excluded when filtering by date)");
  expect(totals.textContent).not.toContain("Without valid timestamp: 3");
  fireEvent.change(screen.getByLabelText("Activity from date"),{target:{value:"2026-04-01"}});
  fireEvent.change(screen.getByLabelText("Activity to date"),{target:{value:"2026-04-01"}});
  expect(screen.getByRole("status").textContent).toContain("Showing 1 of 3");
  expect(totals.textContent).toContain("Without valid timestamp: 2");
  expect(screen.queryByText("APP GROUP DELETE")).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"Clear activity filters"}));
  expect(screen.getByRole("status").textContent).toContain("Showing 3 of 3");
  expect(fetchMock.mock.calls).toHaveLength(3);
  expect(fetchMock.mock.calls.every(([url,init])=>String(url).startsWith("/api/tenants/tenant-a/")&&(!init?.method||init.method==="GET"))).toBe(true);
});

it("#399 uses a valid update timestamp when creation time is malformed without leaking unrelated activity", async () => {
  const history=[
    {id:"op-fallback",resourceType:"AppGroup",resourceId:"group-a",type:"APP_GROUP_ROLLBACK",status:"Succeeded",createdAt:"invalid",updatedAt:"2026-04-02T16:00:00Z"},
    {id:"op-creation",resourceType:"AppGroup",resourceId:"group-a",type:"APP_GROUP_DEPLOY",status:"Pending",createdAt:"2026-04-01T09:00:00Z",updatedAt:"2026-04-03T16:00:00Z"},
    {id:"op-undated",resourceType:"AppGroup",resourceId:"group-a",type:"APP_GROUP_DEPLOY",status:"Failed",createdAt:"invalid"},
    {id:"op-foreign",resourceType:"AppGroup",resourceId:"group-b",type:"APP_GROUP_DELETE",status:"Failed",updatedAt:"2026-04-02T16:00:00Z"},
  ];
  const fetchMock=vi.fn(async (input:RequestInfo|URL,init?:RequestInit)=>{
    const path=String(input);
    if(path==="/api/tenants/tenant-a/operations")return json(history);
    if(path==="/api/tenants/tenant-a/app-groups/group-a/single-apps"||path==="/api/tenants/tenant-a/app-groups/group-a/deployments")return json([]);
    throw new Error("Unexpected path "+path);
  });
  vi.stubGlobal("fetch",fetchMock);
  render(<AppGroupActivity tenantId="tenant-a" appGroupId="group-a"/>);
  const totals=screen.getByLabelText("Loaded related activity status totals");
  await waitFor(()=>expect(screen.getByRole("status").textContent).toContain("Showing 3 of 3"));
  expect(totals.textContent).toContain("Without valid timestamp: 1");
  fireEvent.change(screen.getByLabelText("Activity from date"),{target:{value:"2026-04-02"}});
  fireEvent.change(screen.getByLabelText("Activity to date"),{target:{value:"2026-04-02"}});
  expect(screen.getByRole("status").textContent).toContain("Showing 1 of 3");
  expect(screen.getByText("APP GROUP ROLLBACK")).toBeTruthy();
  expect(screen.queryByText("APP GROUP DELETE")).toBeNull();
  expect(screen.queryByRole("link",{name:/APP GROUP DEPLOY.*Failed/})).toBeNull();
  expect(screen.queryByRole("link",{name:/APP GROUP DELETE/})).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"Clear activity filters"}));
  fireEvent.change(screen.getByLabelText("Sort App Group activity"),{target:{value:"newest"}});
  const order=()=>screen.getAllByRole("link").map(link=>link.getAttribute("href")).filter(href=>href?.startsWith("/tenants/tenant-a/operations/"));
  expect(order()).toEqual([
    "/tenants/tenant-a/operations/op-fallback",
    "/tenants/tenant-a/operations/op-creation",
    "/tenants/tenant-a/operations/op-undated",
  ]);
  expect(fetchMock.mock.calls).toHaveLength(3);
  expect(fetchMock.mock.calls.every(([url,init])=>String(url).startsWith("/api/tenants/tenant-a/")&&(!init?.method||init.method==="GET"))).toBe(true);
});
