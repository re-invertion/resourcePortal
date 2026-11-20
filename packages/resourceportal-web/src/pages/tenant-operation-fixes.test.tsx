import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TenantAuditPage, TenantOperationsPage, auditDateTimeIso, invalidAuditTimeRange, mayRetryOperation, operationUpdatedAt, operationWithinTimeRange, invalidOperationTimeRange } from "./tenant-activity-pages";

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

it("never retries successful or deployment mirror operations", () => {
  expect(mayRetryOperation({ type: "APP_GROUP_DEPLOY", status: "Failed" })).toBe(false);
  expect(mayRetryOperation({ type: "MAINTENANCE", status: "Succeeded" })).toBe(false);
  expect(mayRetryOperation({ type: "MAINTENANCE", status: "Pending" })).toBe(false);
  expect(mayRetryOperation({ type: "MAINTENANCE", status: "Failed" })).toBe(true);
  expect(mayRetryOperation({ type: "MAINTENANCE", status: "RollbackFailed" })).toBe(true);
});

it("shows the same best known operation update timestamp on list and detail", () => {
  expect(operationUpdatedAt({ createdAt: "a", startedAt: "b", completedAt: "c" })).toBe("c");
  expect(operationUpdatedAt({ createdAt: "a", startedAt: "b" })).toBe("b");
  expect(operationUpdatedAt({ createdAt: "a" })).toBe("a");
});

it("hides retry for a successful operation", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) =>
    json(String(input).endsWith("/events") ? [] : {
      id: "op1", type: "VOLUME_CREATE", status: "Succeeded", createdAt: "2026-10-10T10:00:00Z", completedAt: "2026-10-10T10:01:00Z",
    })
  ));
  render(<TenantOperationsPage tenantId="t1" operationId="op1" />);
  expect(await screen.findByText("Succeeded")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Retry operation" })).toBeNull();
});

it("shows the recorded failure reason and a retry action for retryable operations", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) =>
    json(String(input).endsWith("/events") ? [] : {
      id: "op2", type: "VOLUME_CREATE", status: "Failed", errorCode: "BackendUnavailable",
      errorMessage: "Volume service is not reachable", createdAt: "2026-10-10T10:00:00Z", completedAt: "2026-10-10T10:01:00Z",
    })
  ));
  render(<TenantOperationsPage tenantId="t1" operationId="op2" />);
  expect(await screen.findByText(/Volume service is not reachable/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Retry operation" })).toBeTruthy();
});

it("#399 filters tenant operations by resource name and actor without issuing write requests", async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json([
    { id: "op1", type: "VOLUME_CREATE", status: "Succeeded", resourceName: "backup-photos", createdByDisplayName: "Alice Operator", createdAt: "2026-10-10T10:01:00Z" },
    { id: "op2", type: "VOLUME_CREATE", status: "Failed", resourceName: "database", createdByDisplayName: "Bob Operator", createdAt: "2026-10-10T10:02:00Z" },
  ]));
  vi.stubGlobal("fetch", fetchMock);
  render(<TenantOperationsPage tenantId="t1" />);
  expect(await screen.findByText("backup-photos")).toBeTruthy();
  const search = screen.getByRole("textbox", { name: "Search operations" });
  fireEvent.change(search, { target: { value: "backup-photos" } });
  expect(screen.getByText("backup-photos")).toBeTruthy();
  expect(screen.queryByText("database")).toBeNull();
  fireEvent.change(search, { target: { value: "Bob Operator" } });
  expect(screen.getByText("database")).toBeTruthy();
  expect(screen.queryByText("backup-photos")).toBeNull();
  expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
});

it("#399 shows a friendly operation resource name with its technical type as secondary context", async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json([
    { id: "op1", type: "APP_GROUP_DEPLOY", status: "Pending", resourceName: "photos service", resourceType: "AppGroupDeployment", createdAt: "2026-10-10T10:01:00Z" },
    { id: "op2", type: "VOLUME_CREATE", status: "Succeeded", resourceType: "Volume", createdAt: "2026-10-10T10:02:00Z" },
  ]));
  vi.stubGlobal("fetch", fetchMock);
  render(<TenantOperationsPage tenantId="t1" />);
  expect(await screen.findByText("photos service")).toBeTruthy();
  expect(screen.getByText("AppGroupDeployment")).toBeTruthy();
  expect(screen.getByText("Volume")).toBeTruthy();
  fireEvent.change(screen.getByRole("combobox", { name: "Operation status" }), { target: { value: "Pending" } });
  expect(screen.getByText("photos service")).toBeTruthy();
  expect(screen.queryByText("Volume")).toBeNull();
  expect(fetchMock.mock.calls.every(([input]) => String(input).includes("/api/tenants/t1/operations"))).toBe(true);
});

it("#399 updated-time filter includes bounds and excludes undated operations only when active", () => {
  const before = { updatedAt: "2026-10-10T08:00:00Z" };
  const inRange = { updatedAt: "2026-10-10T10:00:00Z" };
  const after = { updatedAt: "2026-10-10T12:00:00Z" };
  const from = "2026-10-10T09:00:00Z", to = "2026-10-10T11:00:00Z";
  expect(operationWithinTimeRange(before, from, to)).toBe(false);
  expect(operationWithinTimeRange(inRange, from, to)).toBe(true);
  expect(operationWithinTimeRange(after, from, to)).toBe(false);
  expect(operationWithinTimeRange({ createdAt: "2026-10-10T10:00:00Z" }, from, to)).toBe(true);
  expect(operationWithinTimeRange({}, "", "")).toBe(true);
  expect(operationWithinTimeRange({}, from, "")).toBe(false);
});

it("#399 filters tenant Operations by entered update range without extra API requests", async () => {
  const localBound = new Date(2026, 9, 10, 11, 0);
  const oldTimestamp = new Date(localBound.getTime() - 60 * 60 * 1000).toISOString();
  const recentTimestamp = new Date(localBound.getTime() + 60 * 60 * 1000).toISOString();
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json([
    { id: "old", resourceName: "old backup", status: "Succeeded", updatedAt: oldTimestamp },
    { id: "recent", resourceName: "recent backup", status: "Pending", updatedAt: recentTimestamp },
  ]));
  vi.stubGlobal("fetch", fetchMock);
  render(<TenantOperationsPage tenantId="t1" />);
  expect(await screen.findByText("old backup")).toBeTruthy();
  expect(screen.getByText("recent backup")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Operations updated from"), { target: { value: "2026-10-10T11:00" } });
  expect(screen.queryByText("old backup")).toBeNull();
  expect(screen.getByText("recent backup")).toBeTruthy();
  expect(fetchMock.mock.calls.every(([input, init]) => String(input).includes("/api/tenants/t1/operations") && (!init?.method || init.method === "GET"))).toBe(true);
});

it("#399 detects reversed operation time ranges without changing server data", () => {
  expect(invalidOperationTimeRange("2026-10-10T12:00:00Z", "2026-10-10T11:00:00Z")).toBe(true);
  expect(invalidOperationTimeRange("2026-10-10T11:00:00Z", "2026-10-10T11:00:00Z")).toBe(false);
  expect(invalidOperationTimeRange("", "2026-10-10T11:00:00Z")).toBe(false);
});

it("#399 exposes filter counts, clear filters, and an empty-filter state without write requests", async () => {
  const fetchMock=vi.fn(async (_input:RequestInfo|URL,_init?:RequestInit)=>json([
    {id:"op1",status:"Succeeded",resourceName:"alpha-backup",updatedAt:"2026-10-10T10:00:00Z"},
    {id:"op2",status:"Failed",resourceName:"beta-backup",updatedAt:"2026-10-10T11:00:00Z"},
  ]));
  vi.stubGlobal("fetch",fetchMock);
  render(<TenantOperationsPage tenantId="t1"/>);
  expect(await screen.findByText("alpha-backup")).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("2 of 2 loaded recent operations");
  fireEvent.change(screen.getByRole("textbox",{name:"Search operations"}),{target:{value:"nonexistent"}});
  expect(screen.getByText("No matching operations")).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("0 of 2 loaded recent operations");
  fireEvent.click(screen.getByRole("button",{name:"Clear filters"}));
  expect(screen.getByText("alpha-backup")).toBeTruthy();
  expect(screen.getByText("beta-backup")).toBeTruthy();
  expect(fetchMock.mock.calls.every(([,init])=>!init?.method||init.method==="GET")).toBe(true);
});

it("#399 warns about reversed local datetime filters and restores operations after correction", async () => {
  vi.stubGlobal("fetch",vi.fn(async()=>json([{id:"op1",status:"Succeeded",resourceName:"backup",updatedAt:"2026-10-10T10:00:00Z"}])));
  render(<TenantOperationsPage tenantId="t1"/>);
  expect(await screen.findByText("backup")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Operations updated from"),{target:{value:"2026-10-10T12:00"}});
  fireEvent.change(screen.getByLabelText("Operations updated to"),{target:{value:"2026-10-10T11:00"}});
  expect(screen.getByRole("alert").textContent).toMatch(/earlier than or equal/);
  expect(screen.queryByText("backup")).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"Clear filters"}));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText("backup")).toBeTruthy();
});

it("#399 never presents the loaded 100-operation window as a complete tenant total", async () => {
  const loaded = Array.from({length:100},(_,i)=>({
    id:`op-${i}`, type:"MAINTENANCE", status:"Succeeded", resourceName:`job-${i}`,
    updatedAt:"2026-10-10T11:00:00Z"
  }));
  vi.stubGlobal("fetch",vi.fn(async()=>json(loaded)));
  render(<TenantOperationsPage tenantId="t1"/>);
  expect(await screen.findByText("job-0")).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("100 of 100 loaded recent operations");
  expect(screen.getByText(/may not include older history/i)).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox",{name:"Search operations"}),{target:{value:"job-99"}});
  expect(screen.getByRole("status").textContent).toContain("1 of 100 loaded recent operations");
});

it("#399 labels the bounded audit page and restores records when filters clear", async () => {
  const fetchMock=vi.fn(async (_input:RequestInfo|URL,_init?:RequestInit)=>json([
    {id:"audit-1",action:"quota.update",actorName:"Alice",resourceName:"volume-a",result:"Success",timestamp:"2026-10-10T10:00:00Z"},
    {id:"audit-2",action:"domain.update",actorName:"Bob",resourceName:"domain-b",result:"Success",timestamp:"2026-10-10T11:00:00Z"},
  ]));
  vi.stubGlobal("fetch",fetchMock);
  render(<TenantAuditPage tenantId="t1"/>);
  expect(await screen.findByRole("status")).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("Showing 2 matching audit records");
  expect(screen.getByRole("status").textContent).toMatch(/up to 100/);
  fireEvent.change(screen.getByLabelText("Actor"),{target:{value:"Alice"}});
  expect(await screen.findByRole("status")).toBeTruthy();
  expect(screen.getByRole("button",{name:"Clear audit filters"})).toBeTruthy();
  fireEvent.click(screen.getByRole("button",{name:"Clear audit filters"}));
  expect((screen.getByLabelText("Actor") as HTMLInputElement).value).toBe("");
  expect((screen.getByRole("button",{name:"Clear audit filters"}) as HTMLButtonElement).disabled).toBe(true);
  expect(fetchMock.mock.calls.every(([url,init])=>String(url).includes("/api/tenants/t1/audit-log")&&(!init?.method||init.method==="GET"))).toBe(true);
});

it("#399 converts audit local input bounds to UTC only for API requests and exports", async () => {
  const fetchMock=vi.fn(async (_input:RequestInfo|URL,_init?:RequestInit)=>json([{id:"audit-1",action:"quota.update",actorName:"Alice",result:"Success",timestamp:"2026-10-10T10:00:00Z"}]));
  vi.stubGlobal("fetch",fetchMock);
  render(<TenantAuditPage tenantId="t1"/>);
  expect(await screen.findByRole("status")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("From"),{target:{value:"2026-10-10T10:00"}});
  const input=screen.getByLabelText("From") as HTMLInputElement;
  expect(input.value).toBe("2026-10-10T10:00");
  expect(String(fetchMock.mock.lastCall?.[0])).toContain(encodeURIComponent(auditDateTimeIso("2026-10-10T10:00")));
  expect(screen.getByText("Export CSV").closest("a")?.getAttribute("href")).toContain(encodeURIComponent(auditDateTimeIso("2026-10-10T10:00")));
  expect(invalidAuditTimeRange("2026-10-10T12:00","2026-10-10T11:00")).toBe(true);
  expect(invalidAuditTimeRange("2026-10-10T10:00","2026-10-10T10:00")).toBe(false);
});

it("#399 blocks audit export for reversed dates and recovers with clear filters", async () => {
  const fetchMock=vi.fn(async (_input:RequestInfo|URL,_init?:RequestInit)=>json([{id:"a1",action:"quota.update",actorName:"Alice",result:"Success",timestamp:"2026-10-10T10:00:00Z"}]));
  vi.stubGlobal("fetch",fetchMock);
  render(<TenantAuditPage tenantId="t1"/>);
  expect(await screen.findByRole("status")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("From"),{target:{value:"2026-10-10T12:00"}});
  fireEvent.change(screen.getByLabelText("To"),{target:{value:"2026-10-10T11:00"}});
  expect(screen.getByRole("alert").textContent).toMatch(/Correct the range/);
  expect(screen.getByRole("status").textContent).toContain("Showing 0 matching audit records");
  expect(screen.getByText("Export CSV").closest("a")).toBeNull();
  expect(screen.getByText("Export JSON").closest("a")).toBeNull();
  expect(fetchMock.mock.calls.every(([url,init])=>String(url).includes("/api/tenants/t1/audit-log")&&(!init?.method||init.method==="GET"))).toBe(true);
  fireEvent.click(screen.getByRole("button",{name:"Clear audit filters"}));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText("Export CSV").closest("a")).not.toBeNull();
});

it("#399 manually refreshes the operations list without modifying tenant data", async () => {
  let reads=0;
  const fetchMock=vi.fn(async (_url:RequestInfo|URL,_init?:RequestInit)=>json([
    {id:"op-refresh",type:"MAINTENANCE",status:++reads===1?"Pending":"Succeeded",resourceName:"refresh-target"},
  ]));
  vi.stubGlobal("fetch",fetchMock);
  render(<TenantOperationsPage tenantId="t1"/>);
  expect((await screen.findAllByText("Pending")).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button",{name:"Refresh operations"}));
  await waitFor(()=>expect(screen.getAllByText("Succeeded").length).toBeGreaterThan(0));
  expect(reads).toBeGreaterThanOrEqual(2);
  expect(fetchMock.mock.calls.every(([url,init])=>String(url).includes("/api/tenants/t1/operations")&&(!init?.method||init.method==="GET"))).toBe(true);
});

it("#399 refreshes operation status and events together without treating accepted as completed", async () => {
  let detailReads=0, eventReads=0;
  const fetchMock=vi.fn(async (url:RequestInfo|URL,_init?:RequestInit)=>{
    if(String(url).endsWith("/events"))return json(eventReads++===0?[]:[{id:"event-1",type:"progress",message:"Work is still running"}]);
    return json({id:"op1",type:"VOLUME_CREATE",status:++detailReads===1?"Pending":"Running",createdAt:"2026-10-10T10:00:00Z"});
  });
  vi.stubGlobal("fetch",fetchMock);
  render(<TenantOperationsPage tenantId="t1" operationId="op1"/>);
  expect(await screen.findByText("Pending")).toBeTruthy();
  expect(screen.getByText(/accepted request does not mean an operation has completed/i)).toBeTruthy();
  fireEvent.click(screen.getByRole("button",{name:"Refresh status"}));
  expect(await screen.findByText("Running")).toBeTruthy();
  await waitFor(()=>expect(screen.getByText("Work is still running")).toBeTruthy());
  expect(detailReads).toBeGreaterThanOrEqual(2);
  expect(eventReads).toBeGreaterThanOrEqual(2);
  expect(fetchMock.mock.calls.every(([url,init])=>String(url).startsWith("/api/tenants/t1/operations/op1")&&(!init?.method||init.method==="GET"))).toBe(true);
});

it("#399 warns when refreshing previously loaded operations fails and clears warning on retry", async () => {
  let request=0;
  const fetchMock=vi.fn(async (_url:RequestInfo|URL,_init?:RequestInit)=>{
    request+=1;
    if(request===2)throw new Error("network disconnected");
    return json([{id:"op1",type:"MAINTENANCE",status:request===1?"Pending":"Succeeded",resourceName:"status-probe"}]);
  });
  vi.stubGlobal("fetch",fetchMock);
  render(<TenantOperationsPage tenantId="t1"/>);
  expect((await screen.findAllByText("Pending")).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button",{name:"Refresh operations"}));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toMatch(/may be stale/i);
  expect(screen.getByText("status-probe")).toBeTruthy();
  fireEvent.click(screen.getByRole("button",{name:"Refresh operations"}));
  await waitFor(()=>expect(screen.queryByRole("alert")).toBeNull());
  expect(screen.getAllByText("Succeeded").length).toBeGreaterThan(0);
  expect(fetchMock.mock.calls.every(([url,init])=>String(url).includes("/api/tenants/t1/operations")&&(!init?.method||init.method==="GET"))).toBe(true);
});

it("#399 marks partly refreshed operation detail and events as stale on one failed GET", async () => {
  let eventReads=0,detailReads=0;
  const fetchMock=vi.fn(async (url:RequestInfo|URL,_init?:RequestInit)=>{
    if(String(url).endsWith("/events")){
      eventReads++;
      if(eventReads===2)throw new Error("events unavailable");
      return json([{id:"ev1",type:"progress",message:"queued event"}]);
    }
    return json({id:"op1",type:"VOLUME_CREATE",status:++detailReads===1?"Pending":"Running",createdAt:"2026-10-10T10:00:00Z"});
  });
  vi.stubGlobal("fetch",fetchMock);
  render(<TenantOperationsPage tenantId="t1" operationId="op1"/>);
  expect(await screen.findByText("Pending")).toBeTruthy();
  await screen.findByText("queued event");
  fireEvent.click(screen.getByRole("button",{name:"Refresh status"}));
  expect(await screen.findByText("Running")).toBeTruthy();
  await waitFor(()=>expect(screen.getByRole("alert").textContent).toMatch(/operation events/));
  expect(screen.getByRole("alert").textContent).toMatch(/stale or inconsistent/);
  fireEvent.click(screen.getByRole("button",{name:"Refresh status"}));
  await waitFor(()=>expect(screen.queryByRole("alert")).toBeNull());
  expect(fetchMock.mock.calls.every(([url,init])=>String(url).startsWith("/api/tenants/t1/operations/op1")&&(!init?.method||init.method==="GET"))).toBe(true);
});
