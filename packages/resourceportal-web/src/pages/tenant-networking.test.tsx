import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    const { rerender } = render(<TenantNetworkingPage tenantId={tenantId}/>);
    expect(screen.getByRole("navigation", { name: "Networking workspaces" })).toBeTruthy();
    expect(screen.queryByLabelText("Application Network graph")).toBeNull();
    rerender(<TenantNetworkingPage tenantId={tenantId} section="lan"/>);
    expect(screen.getByLabelText("LAN attachments workspace")).toBeTruthy();
    rerender(<TenantNetworkingPage tenantId={tenantId} section="gates"/>);
    expect(screen.getByText("Remote Office")).toBeTruthy();
    rerender(<TenantNetworkingPage tenantId={tenantId} section="vpn"/>);
    expect(screen.getByLabelText("Device VPN workspace")).toBeTruthy();
    rerender(<TenantNetworkingPage tenantId={tenantId} section="topology"/>);
    expect(screen.getByRole("table")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Diagram" }));
    expect(screen.getByLabelText("Application Network graph")).toBeTruthy();
    expect(screen.queryByText(/Site VPN|BGP|RP to LAN firewall/i)).toBeNull();
  });
  it("retains application connections when topology is filtered by Network CIDR or name", () => {
    const app = topology.appGroups[0].singleApps[0];
    const original = app.networkAttachments;
    app.networkAttachments = [{
      id: "aaaaaaaa-bbbb-4ccc-8ddd-555555555555",
      networkId, address: "10.240.4.10",
    }];
    try {
      render(<TenantNetworkingPage tenantId={tenantId} section="topology" />);
      const search = screen.getByRole("searchbox", { name: /Search applications, groups or Networks/i });
      fireEvent.change(search, { target: { value: "10.240.4.0/24" } });
      let row = screen.getByRole("row", { name: /sensors sensor backend 10.240.4.10/i });
      expect(row).toBeTruthy();
      fireEvent.change(search, { target: { value: "backend" } });
      row = screen.getByRole("row", { name: /sensors sensor backend 10.240.4.10/i });
      expect(row).toBeTruthy();
      fireEvent.change(search, { target: { value: "sensor" } });
      expect(screen.getByRole("row", { name: /sensors sensor backend 10.240.4.10/i })).toBeTruthy();
      fireEvent.change(search, { target: { value: "not-a-network" } });
      expect(screen.getByText("No matching application-to-Network connections.")).toBeTruthy();
    } finally {
      app.networkAttachments = original;
    }
  });

  it("links topology connections only to their current tenant group and application", () => {
    const app = topology.appGroups[0].singleApps[0];
    const original = app.networkAttachments;
    app.networkAttachments = [{
      id: "aaaaaaaa-bbbb-4ccc-8ddd-555555555555",
      networkId, address: "10.240.4.10",
    }];
    try {
      render(<TenantNetworkingPage tenantId={tenantId} section="topology" />);
      const table = screen.getByRole("table");
      const group = within(table).getByRole("link", {name:"sensors"});
      const application = within(table).getByRole("link", {name:"sensor"});
      expect(group.getAttribute("href")).toBe(
        "/tenants/"+tenantId+"/app-groups/aaaaaaaa-bbbb-4ccc-8ddd-444444444444",
      );
      expect(application.getAttribute("href")).toBe(
        "/tenants/"+tenantId+"/app-groups/aaaaaaaa-bbbb-4ccc-8ddd-444444444444/apps/"+appId,
      );
      expect(within(table).getByText("backend")).toBeTruthy();
      expect(mock.request).not.toHaveBeenCalled();
    } finally {
      app.networkAttachments = original;
    }
  });

  it("#399 §9 shows at most a focused topology fragment until search and retains full table relationships", () => {
    const group = topology.appGroups[0];
    const originalApps = group.singleApps;
    group.singleApps = Array.from({length: 17}, (_,index)=>({
      id: "app-" + index, name: "sensor-" + index,
      image: "registry.example/service@sha256:" + "a".repeat(64),
      networkAttachments: [{id:"attach-"+index,networkId,address:"10.240.4."+index}],
    }));
    try {
      render(<TenantNetworkingPage tenantId={tenantId} section="topology" />);
      expect(screen.getAllByRole("row").length).toBe(18);
      fireEvent.click(screen.getByRole("button", {name:"Diagram"}));
      expect(screen.getByRole("status").textContent).toContain("Showing 12 of 17 applications");
      fireEvent.change(screen.getByRole("searchbox", {name:/Search applications, groups or Networks/i}),
        {target:{value:"sensor-16"}});
      expect(screen.queryByText(/Showing 12 of 17/)).toBeNull();
      expect(screen.getByLabelText("Application Network graph")).toBeTruthy();
    } finally {
      group.singleApps = originalApps;
    }
  });

  it("#399 §9 renders short image identifiers in graph nodes and stores full digests for selected details", async () => {
    const { buildTopologyGraph } = await vi.importActual<typeof import("./tenant-networking-graph")>("./tenant-networking-graph");
    const digest = "sha256:" + "c".repeat(64);
    const t = { ...topology, appGroups: [{...topology.appGroups[0],
      singleApps: [{ ...topology.appGroups[0].singleApps[0],
        image:"registry.example/team/sensor@" + digest }]}]};
    const graph = buildTopologyGraph(t);
    const node = graph.nodes.find(item=>item.id==="app:"+appId);
    expect(node?.data.detail).toBe("sensor");
    expect(node?.data.imageDetail).toBe("registry.example/team/sensor@" + digest);
    expect(node?.data.detail).not.toContain(digest);
  });

  it("#399 §9 requires explicit application/network selections and gives a disabled reason", () => {
    render(<TenantNetworkingPage tenantId={tenantId}/>);
    expect(screen.getByRole("status").textContent).toMatch(/select both an Application and a Network/);
    expect(screen.getByLabelText("Application").hasAttribute("required")).toBe(true);
    expect(screen.getByLabelText("Network").hasAttribute("required")).toBe(true);
    expect(screen.getByRole("button", {name:"Connect application"}).hasAttribute("disabled")).toBe(true);
  });

  it("creates an RP Gate with a one-time LAN enrollment flow",async()=>{
    mock.request.mockResolvedValueOnce({
      enrollment:{token:"test-token",expiresAt:"2026-10-23T15:00:00Z"},
    });
    render(<TenantNetworkingPage tenantId={tenantId} section="gates"/>);
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
    // Opening the modal makes the page inert/aria-hidden. Target the visible
    // confirmation action, never a background button hidden from accessibility.
    const dialog = screen.getByRole("dialog", { name: "Create Network" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create Network" }));
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
