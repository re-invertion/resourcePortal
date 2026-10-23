import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TenantNetworkingPage } from "./tenant-networking";
import type { Topology } from "./tenant-networking-graph";

const mock=vi.hoisted(()=>({request:vi.fn(),reload:vi.fn().mockResolvedValue(undefined)}));
vi.mock("../api/client",()=>({apiRequest:mock.request}));
vi.mock("../hooks/use-api",()=>({
  useApi:()=>({data:topology,loading:false,error:null,reload:mock.reload}),
  formatDate:()=> "Oct 23",
}));
vi.mock("./remote-lan-attachments-panel",()=>({
  RemoteLanAttachmentsPanel:()=> <p>LAN Attachments</p>,
}));
vi.mock("./device-vpn-panel",()=>({
  DeviceVpnPanel:()=> <p>Device VPN</p>,
}));
vi.mock("./tenant-networking-graph",()=>({
  TenantNetworkingGraph:()=> <div aria-label="Application Network graph">Graph</div>,
}));
vi.mock("../components/toast",()=>({
  toast:{success:vi.fn(),errorFrom:vi.fn()},
}));
const gateId="aaaaaaaa-bbbb-4ccc-8ddd-111111111111";
const tenantId="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const networkId="aaaaaaaa-bbbb-4ccc-8ddd-222222222222";
const appId="aaaaaaaa-bbbb-4ccc-8ddd-333333333333";
const topology:Topology={
  gates:[{id:gateId,name:"Remote Office",status:"Ready",configRevision:2,agentVersion:"gate-l2-v1"}],
  networks:[{id:networkId,name:"backend",status:"Ready",revision:3,
    cidr:"10.240.4.0/24",overlayCidr:"10.200.4.0/24",attachments:[]}],
  appGroups:[{id:"aaaaaaaa-bbbb-4ccc-8ddd-444444444444",name:"sensors",
    hasPendingChanges:false,singleApps:[{id:appId,name:"sensor",networkAttachments:[]}]}],
};
const root="/api/tenants/"+tenantId+"/networking";
beforeEach(()=>{
  mock.request.mockReset();
  mock.reload.mockClear();
  mock.request.mockResolvedValue({id:"op-1",status:"Succeeded"});
});
describe("Tenant networking without routed Site VPN",()=>{
  it("shows app networks, LAN Attachments, RP Gate and separate Device VPN",()=>{
    render(<TenantNetworkingPage tenantId={tenantId}/>);
    expect(screen.getByText("LAN Attachments")).toBeTruthy();
    expect(screen.getByText("Device VPN")).toBeTruthy();
    expect(screen.getByText("Remote Office")).toBeTruthy();
    expect(screen.getByLabelText("Application Network graph")).toBeTruthy();
    expect(screen.queryByText(/Site VPN|BGP|RP to LAN firewall/i)).toBeNull();
  });
  it("creates an RP Gate with a one-time LAN enrollment flow",async()=>{
    mock.request.mockResolvedValueOnce({
      enrollment:{token:"test-token",expiresAt:"2026-10-23T15:00:00Z"},
    });
    render(<TenantNetworkingPage tenantId={tenantId}/>);
    fireEvent.click(screen.getByRole("button",{name:"Add RP Gate"}));
    fireEvent.change(screen.getByPlaceholderText("remote-gate"),{target:{value:"office-gate"}});
    fireEvent.click(screen.getByRole("button",{name:"Create RP Gate"}));
    await waitFor(()=>expect(mock.request).toHaveBeenCalledWith(root+"/gates",{
      method:"POST",body:{name:"office-gate",description:undefined},
    }));
    expect(await screen.findByText(/curl -fsSL/)).toBeTruthy();
    expect(screen.queryByText(/Site VPN|BGP/i)).toBeNull();
  });
  it("creates a tenant Network without creating a site route",async()=>{
    render(<TenantNetworkingPage tenantId={tenantId}/>);
    fireEvent.click(screen.getAllByRole("button",{name:"Create Network"})[0]);
    fireEvent.change(screen.getByPlaceholderText("private-network"),{target:{value:"private-backend"}});
    fireEvent.click(screen.getAllByRole("button",{name:"Create Network"})[1]);
    await waitFor(()=>expect(mock.request).toHaveBeenCalledWith(root+"/networks",{
      method:"POST",body:{name:"private-backend",description:undefined,cidr:undefined},
    }));
  });
  it("attaches one application to an RP Network using the existing durable operation",async()=>{
    render(<TenantNetworkingPage tenantId={tenantId}/>);
    fireEvent.change(screen.getByLabelText("Application"),{target:{value:appId}});
    fireEvent.change(screen.getByLabelText("Network"),{target:{value:networkId}});
    fireEvent.click(screen.getByRole("button",{name:"Connect application"}));
    await waitFor(()=>expect(mock.request).toHaveBeenCalledWith(
      root+"/networks/"+networkId+"/attachments",
      expect.objectContaining({
        method:"POST",body:{singleAppId:appId,expectedRevision:3},
        headers:expect.objectContaining({"idempotency-key":expect.any(String)}),
      }),
    ));
    expect(mock.reload).toHaveBeenCalled();
  });
});
