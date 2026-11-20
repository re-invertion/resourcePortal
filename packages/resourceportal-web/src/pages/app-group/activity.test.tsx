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
  expect(screen.getByRole("status").textContent).toContain("1 explicitly related operations");
  fireEvent.click(screen.getByRole("button",{name:"Refresh activity"}));
  await waitFor(() => expect(screen.getByRole("row", { name: /APP GROUP DEPLOY Succeeded/i })).toBeTruthy();
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
  expect(await screen.findByRole("row",{name:/APP GROUP DEPLOY Pending/i})).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Filter App Group activity status"),{target:{value:"Pending"}});
  fireEvent.click(screen.getByRole("button",{name:"Refresh activity"}));
  await waitFor(()=>expect(screen.getByRole("status").textContent).toContain("Showing 0 of 1"));
  const filter=screen.getByLabelText("Filter App Group activity status") as HTMLSelectElement;
  expect(filter.value).toBe("Pending");
  expect(screen.getByRole("option",{name:"Pending"})).toBeTruthy();
  expect(screen.queryByRole("row",{name:/APP GROUP DEPLOY/})).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"Clear activity filters"}));
  expect(await screen.findByRole("row",{name:/APP GROUP DEPLOY Succeeded/i})).toBeTruthy();
});
