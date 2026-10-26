import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import {
  GATE_CONTAINER_PORT, gateRuntimeConfig, gateStackDigest, renderGateStack,
  type GateStackInput,
} from "./gate-stack";

const app = {
  attachmentId:"aaaaaaaa-bbbb-4ccc-8ddd-aaaaaaaaaaaa",
  tenantId:"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  singleAppId:"aaaaaaaa-bbbb-4ccc-8ddd-dddddddddddd",
  gateId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  networkId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  overlayCidr:"10.200.12.0/24",
  serviceName:"rp_aaaaaaaa_bbbb_4ccc_8ddd_eeeeeeeeeeee_sensor",
  macAddress:"02:aa:bb:cc:dd:ee",
};
const input:GateStackInput={
  gateId:app.gateId,
  image:"ghcr.io/re-invertion/resourceportal-api:test",
  publishedPort:52042,
  serverTunnelAddress:"10.253.0.1/30",
  clientTunnelAddress:"10.253.0.2/30",
  peerPublicKey:"peer-public-key",
  privateSecretName:"rp-gate-private-v1",
  networks:[{
    id:app.networkId,
    swarmNetworkName:"rp-network-"+app.networkId,
    overlayCidr:app.overlayCidr,
  }],
  remoteLanAttachments:[app],
};
type Stack = {
  services: {gateway:{
    ports:Array<{target:number;published:number;protocol:string;mode:string}>;
    cap_add:string[];command:string[];environment:Record<string,string>;
    sysctls:Record<string,string>;
    volumes?:unknown;
  }};
  networks: Record<string,{external:boolean;name:string}>;
};
describe("LAN Attachments-only Gateway stack rendering",()=>{
  it("publishes only one encrypted /30 endpoint and the selected application overlay",()=>{
    const stack=parse(renderGateStack(input)) as Stack;
    expect(stack.services.gateway.ports).toEqual([{
      target:GATE_CONTAINER_PORT,published:52042,protocol:"udp",mode:"ingress",
    }]);
    expect(stack.services.gateway.cap_add).toEqual(["NET_ADMIN","NET_RAW"]);
    expect(stack.services.gateway.sysctls).toEqual({"net.ipv4.ip_forward":"0"});
    expect(stack.services.gateway.command).toContain("dist/src/networking/remote-lan-gateway.runner.js");
    expect(stack.services.gateway.environment.RP_REMOTE_LAN_GATEWAY_ENABLED).toBe("true");
    expect(stack.networks["rpnet_"+app.networkId.replaceAll("-","_")]).toEqual({
      external:true,name:"rp-network-"+app.networkId,
    });
    expect(stack.services.gateway).not.toHaveProperty("volumes");
  });
  it("publishes only app-scoped L2 grants, never Site-level routing or stable DNAT",()=>{
    const runtime=gateRuntimeConfig(input);
    expect(runtime.rpOverlayCidrs).toEqual([app.overlayCidr]);
    expect(runtime.remoteLanAttachments).toEqual([app]);
    expect(JSON.stringify(runtime)).not.toMatch(/allowLanToRp|allowRpToLan|peerLanCidrs|mappings|applicationAccessMode|discoveryRules/);
    expect(renderGateStack(input)).not.toMatch(/RP-GATE-FWD|iptables|site-vpn/);
  });
  it("keeps grant ordering deterministic and tracks MAC changes in the digest",()=>{
    const reversed={...input,remoteLanAttachments:[...input.remoteLanAttachments].reverse(),
      networks:[...input.networks].reverse()};
    expect(gateStackDigest(reversed)).toBe(gateStackDigest(input));
    const altered={...input,remoteLanAttachments:[{...app,macAddress:"02:aa:bb:cc:dd:ff"}]};
    expect(gateStackDigest(altered)).not.toBe(gateStackDigest(input));
  });
  it("disables bridging for empty grant snapshots while retaining tunnel identity",()=>{
    const disabled={...input,remoteLanAttachments:[]};
    const stack=parse(renderGateStack(disabled)) as Stack;
    expect(stack.services.gateway.environment.RP_REMOTE_LAN_GATEWAY_ENABLED).toBe("false");
    expect(gateRuntimeConfig(disabled).remoteLanAttachments).toEqual([]);
  });
});
