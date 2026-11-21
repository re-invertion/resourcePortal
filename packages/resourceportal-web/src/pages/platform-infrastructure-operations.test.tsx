import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlatformPage } from "./platform";
import { platformCapacityAlias, platformRemoteLocationLabel } from "./platform-final-pages";

function json(value: unknown) {
  return new Response(JSON.stringify(value), {status:200,headers:{"content-type":"application/json"}});
}
const locationId="aaaaaaaa-bbbb-4ccc-8ddd-111111111111";
const gpuUuid="GPU-aaaaaaaa-bbbb-4ccc-8ddd-aaaaaaaaaaaa";
afterEach(()=>{cleanup();vi.unstubAllGlobals();});

describe("#399 §10 Infrastructure scoped operational workflows",()=>{
  it("uses platform-only aliases and deterministic names without private tenant lookups",()=>{
    expect(platformCapacityAlias("11111111-1111-4111-8111-123456789abc")).toBe("App …56789abc");
    expect(platformRemoteLocationLabel({id:locationId,hostname:"swarm-edge-01"})).toBe("swarm-edge-01");
    expect(platformRemoteLocationLabel({id:locationId,swarmNodeId:"abcdefghijklm"})).toBe("Swarm node …fghijklm");
    expect(platformRemoteLocationLabel({id:locationId})).toBe("Location …11111111");
  });

  it("shows full application IDs with a scoped operational alias and complete prediction explanations",async()=>{
    const appId="11111111-1111-4111-8111-123456789abc";
    const fetcher=vi.fn(async(input:RequestInfo|URL)=>{
      if(String(input)==="/api/platform/capacity")return json({
        predictions:[{appId,predictedBytes:"1073741824",p99Bytes:"0",max7dBytes:"0",sampleCount:0,usedPolicyFallback:true,confidence:0}],
      });
      return json([]);
    });
    vi.stubGlobal("fetch",fetcher);
    render(<PlatformPage section="infrastructure" segments={["capacity"]}/>);
    expect(await screen.findByText("App …56789abc")).toBeTruthy();
    expect(screen.getByText(appId)).toBeTruthy();
    expect(screen.getAllByText(/Conservative policy fallback/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Platform-scoped operational alias only/)).toBeTruthy();
    expect(fetcher.mock.calls.every(([input])=>!String(input).startsWith("/api/tenants/"))).toBe(true);
  });

  it("shows a useful remote name, reads only platform details and requests audited maintenance",async()=>{
    const fetcher=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
      const path=String(input);
      if(path==="/api/platform/remote-locations")return json([{id:locationId,hostname:"site-edge-01",status:"Ready",maintenance:false}]);
      if(path==="/api/platform/remote-locations/"+locationId && init?.method==="GET")return json({id:locationId,hostname:"site-edge-01",status:"Ready",availability:"Active",maintenance:false,swarmNodeId:"node-01"});
      if(path==="/api/platform/remote-locations/"+locationId+"/maintenance" && init?.method==="PATCH")return json({id:"operation-123",status:"Pending"});
      return json([]);
    });
    vi.stubGlobal("fetch",fetcher);
    render(<PlatformPage section="infrastructure" segments={["locations"]}/>);
    expect(await screen.findByText("site-edge-01")).toBeTruthy();
    fireEvent.click(screen.getByRole("button",{name:"Details & maintenance"}));
    const dialog=await screen.findByRole("dialog",{name:/Remote location: site-edge-01/});
    expect(await within(dialog).findByText("node-01")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button",{name:"Enter maintenance"}));
    await waitFor(()=>expect(fetcher.mock.calls.some(([path,init])=>
      String(path)==="/api/platform/remote-locations/"+locationId+"/maintenance" &&
      init?.method==="PATCH" && String(init.body).includes('"enabled":true'))).toBe(true));
    expect(fetcher.mock.calls.every(([path])=>!String(path).startsWith("/api/tenants/"))).toBe(true);
  });

  it("uses fresh remote details to exit maintenance despite a stale list snapshot",async()=>{
    const fetcher=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
      const path=String(input);
      if(path==="/api/platform/remote-locations")return json([{id:locationId,hostname:"site-edge-01",status:"Ready",maintenance:false}]);
      if(path==="/api/platform/remote-locations/"+locationId && init?.method==="GET")return json({
        id:locationId,hostname:"site-edge-01",status:"Ready",maintenance:true,swarmNodeId:"node-01",
      });
      if(path==="/api/platform/remote-locations/"+locationId+"/maintenance" && init?.method==="PATCH")return json({id:"op-exit",status:"Pending"});
      return json([]);
    });
    vi.stubGlobal("fetch",fetcher);
    render(<PlatformPage section="infrastructure" segments={["locations"]}/>);
    fireEvent.click(await screen.findByRole("button",{name:"Details & maintenance"}));
    const dialog=screen.getByRole("dialog",{name:/Remote location: site-edge-01/});
    const action=within(dialog).getByRole("button",{name:"Exit maintenance"});
    await within(dialog).findByText("node-01");
    expect((action as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(action);
    await waitFor(()=>expect(fetcher.mock.calls.some(([path,init])=>
      String(path)==="/api/platform/remote-locations/"+locationId+"/maintenance" &&
      init?.method==="PATCH" && String(init.body)==='{"enabled":false}')).toBe(true));
  });

  it("preserves assigned GPU and only invokes fail-closed diagnose and recovery operations",async()=>{
    const fetcher=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
      const path=String(input);
      if(path==="/api/platform/gpu-devices")return json([{uuid:gpuUuid,model:"NVIDIA A100",status:"Allocated",allocationState:"Allocated",allocatedSingleAppId:"single-app-private-id",memoryBytes:"42949672960",node:{hostname:"swarm-01",status:"Ready"}}]);
      if(path==="/api/platform/gpu-devices/"+gpuUuid+"/recover"&&init?.method==="POST")return json({id:"op-gpu-1",status:"Pending"});
      if(path==="/api/platform/gpu-devices/"+gpuUuid+"/diagnose"&&init?.method==="POST")return json({id:"op-gpu-2",status:"Pending"});
      return json([]);
    });
    vi.stubGlobal("fetch",fetcher);
    render(<PlatformPage section="infrastructure" segments={["gpus"]}/>);
    expect(await screen.findByText("NVIDIA A100")).toBeTruthy();
    expect(screen.getByText("single-app-private-id")).toBeTruthy();
    expect(screen.getByText(/Assignments belong to SingleApp deployment policy/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button",{name:"Recovery options"}));
    const dialog=screen.getByRole("dialog",{name:"GPU assignment recovery"});
    expect(within(dialog).getByText(/releaseIfUnavailable=false/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button",{name:"Request safe recovery"}));
    await waitFor(()=>expect(fetcher.mock.calls.some(([path,init])=>
      String(path)==="/api/platform/gpu-devices/"+gpuUuid+"/recover" &&
      init?.method==="POST" && String(init.body)==='{"releaseIfUnavailable":false}')).toBe(true));
    expect(fetcher.mock.calls.every(([path])=>!String(path).startsWith("/api/tenants/"))).toBe(true);
    expect(fetcher.mock.calls.every(([path])=>!String(path).includes("/release-allocation"))).toBe(true);
  });
});
