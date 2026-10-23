import { describe, expect, it } from "vitest";
import {planGatewayRuntimeAttachments} from "./remote-lan-gateway-resolver";
import type {GateRuntimeConfig} from "./gate-runtime.types";
const app = {
  attachmentId:"aaaaaaaa-bbbb-4ccc-8ddd-aaaaaaaaaaaa",
  tenantId:"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  singleAppId:"aaaaaaaa-bbbb-4ccc-8ddd-aaaaaaaaaaaa",
  gateId:"aaaaaaaa-bbbb-4ccc-8ddd-bbbbbbbbbbbb",
  networkId:"aaaaaaaa-bbbb-4ccc-8ddd-121212121212",
  overlayCidr:"10.200.42.0/24",
  serviceName:"rp_aaaaaaaa_bbbb_4ccc_8ddd_eeeeeeeeeeee_homeassistant",
  macAddress:"02:aa:bb:cc:dd:ee",
};
const config:GateRuntimeConfig={
  gateId:app.gateId, listenPort:51820,
  serverTunnelAddress:"100.96.0.1/30",
  clientTunnelAddress:"100.96.0.2/30",
  peerPublicKey:"key",privateKeyPath:"/run/secrets/private",
  rpOverlayCidrs:[app.overlayCidr],
  remoteLanAttachments:[app],
};
const interfaces=[{name:"eth1",address:"10.200.42.20"}];
const tasks=new Map([[app.serviceName,["10.200.42.41"]]]);
describe("Gateway LAN task resolution",()=>{
  it("binds exactly one tenant task and the Gateway's real overlay interface",()=>{
    const [plan]=planGatewayRuntimeAttachments(config,interfaces,tasks);
    expect(plan.app.appOverlayIp).toBe("10.200.42.41");
    expect(plan.app.gatewayOverlayIp).toBe("10.200.42.20");
    expect(plan.app.overlayInterface).toBe("eth1");
    expect(plan.wireguard.serverTunnelAddress).toBe("100.96.0.1/30");
  });
  it("rejects second replica, missing Gate interface and overlapping sources",()=>{
    expect(()=>planGatewayRuntimeAttachments(config,interfaces,
      new Map([[app.serviceName,["10.200.42.41","10.200.42.42"]]]))).toThrow();
    expect(()=>planGatewayRuntimeAttachments(config,[],tasks)).toThrow();
    expect(()=>planGatewayRuntimeAttachments(config,[...interfaces,{name:"eth2",address:"10.200.42.21"}],tasks)).toThrow();
  });
  it("rejects a cross-Gate policy or network not carried by the Gate stack",()=>{
    expect(()=>planGatewayRuntimeAttachments({...config,remoteLanAttachments:[{...app,gateId:app.attachmentId}]},interfaces,tasks)).toThrow();
    expect(()=>planGatewayRuntimeAttachments({...config,rpOverlayCidrs:["10.200.40.0/24"]},interfaces,tasks)).toThrow();
    expect(()=>planGatewayRuntimeAttachments({...config,remoteLanAttachments:[{...app,serviceName:"localhost"}]},interfaces,tasks)).toThrow();
  });
  it("requires single application attachment identity",()=>{
    expect(()=>planGatewayRuntimeAttachments({...config,remoteLanAttachments:[app,{...app,attachmentId:"aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff"}]},interfaces,tasks)).toThrow();
    expect(planGatewayRuntimeAttachments({...config,remoteLanAttachments:[]},[],new Map())).toEqual([]);
  });
});
