import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteLanAttachmentsPanel, availableRemoteLanApps } from "./remote-lan-attachments-panel";
import type { Topology } from "./tenant-networking-graph";
import { apiRequest } from "../api/client";

vi.mock("../api/client", () => ({ apiRequest: vi.fn() }));
const mockRequest = vi.mocked(apiRequest);
const gateId = "aaaaaaaa-bbbb-4ccc-8ddd-bbbbbbbbbbbb";
const networkId = "aaaaaaaa-bbbb-4ccc-8ddd-cccccccccccc";
const appId = "aaaaaaaa-bbbb-4ccc-8ddd-aaaaaaaaaaaa";
const attachmentId = "aaaaaaaa-bbbb-4ccc-8ddd-dddddddddddd";
const topology = {
  networks: [{id:networkId,name:"isolated",status:"Ready"}],
  gates: [{id:gateId,name:"customer-rp-gate",status:"Ready",revokedAt:null}],
  appGroups: [{id:appId,name:"sensors",hasPendingChanges:false,
    singleApps:[{id:appId,name:"sensor-app",
      networkAttachments:[{id:attachmentId,networkId,address:"10.200.42.12"}]}]}],
} as unknown as Topology;
const root="/api/tenants/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/networking/lan-attachments";
const record={
  id:attachmentId, singleAppId:appId,networkId,gateId,lanInterface:"eth1",
  lanCidr:"192.168.50.0/24",macAddress:"02:aa:bb:cc:dd:ee",status:"Pending",
  dhcpAddress:null,
};
beforeEach(()=>{
  mockRequest.mockReset();
  mockRequest.mockImplementation(async (path, init)=>{
    if (path===root && (!init?.method || init.method==="GET")) return [] as never;
    if (path===root && init?.method==="POST") return record as never;
    if (path===root+"/"+attachmentId && init?.method==="DELETE") return record as never;
    throw new Error("Unexpected route: "+path);
  });
});
describe("Remote LAN Attachments tenant UI",()=>{
  it("only offers applications with attached tenant Networks",()=>{
    const apps=availableRemoteLanApps(topology);
    expect(apps).toEqual([{id:appId,label:"sensors / sensor-app",networkIds:[networkId]}]);
    expect(availableRemoteLanApps({...topology,appGroups:[]})).toEqual([]);
  });
  it("creates Pending LAN connection for a dedicated unnumbered physical interface",async()=>{
    render(<RemoteLanAttachmentsPanel tenantId="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" topology={topology} />);
    const app=screen.getByLabelText("Application");
    fireEvent.change(app,{target:{value:appId}});
    fireEvent.change(screen.getByLabelText("Application Network"),{target:{value:networkId}});
    fireEvent.change(screen.getByLabelText("RP Gate"),{target:{value:gateId}});
    fireEvent.change(screen.getByLabelText("Dedicated Gate LAN interface"),{target:{value:"eth1"}});
    fireEvent.change(screen.getByLabelText("Expected customer DHCP subnet"),{target:{value:"192.168.50.0/24"}});
    fireEvent.click(screen.getByRole("button",{name:"Create LAN Attachment"}));
    await waitFor(()=>expect(mockRequest).toHaveBeenCalledWith(root, {
      method:"POST",
      body:{singleAppId:appId,networkId,gateId,lanInterface:"eth1",lanCidr:"192.168.50.0/24"},
    }));
  });
  it("tracks MAC, DHCP and revocation without inventing an Active lease",async()=>{
    mockRequest.mockImplementation(async(path,init)=>{
      if(path===root) return [record] as never;
      if(path===root+"/"+attachmentId && init?.method==="DELETE") return record as never;
      throw new Error("Unknown route");
    });
    render(<RemoteLanAttachmentsPanel tenantId="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" topology={topology} />);
    const list=await screen.findByLabelText("Existing LAN Attachments");
    expect(within(list).getByText(/awaiting lease/)).toBeTruthy();
    expect(within(list).getByText("Pending")).toBeTruthy();
    fireEvent.click(within(list).getByRole("button",{name:"Revoke"}));
    await waitFor(()=>expect(mockRequest).toHaveBeenCalledWith(root+"/"+attachmentId,{method:"DELETE"}));
  });
});
