import { describe, expect, it } from "vitest";
import {
  decodeDiscoveryEnvelope, encodeDiscoveryEnvelope, isAttachedOverlaySource,
  validDiscoveryQuery, validDiscoveryResponse, DiscoveryRateLimiter,
} from "./gate-discovery-relay";

const mdns = Buffer.from([0,0,0,0,0,1,0,0,0,0,0,0,0]);
const answer = Buffer.from([0,0,0x84,0,0,1,0,1,0,0,0,0,0]);
const ssdp = Buffer.from(
  'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ssdp:all\r\n\r\n',
);
describe("opt-in discovery relay protocol", () => {
  it("forwards only bounded mDNS queries and valid SSDP M-SEARCH", () => {
    expect(validDiscoveryQuery("mdns", mdns)).toBe(true);
    expect(validDiscoveryResponse("mdns", answer)).toBe(true);
    expect(validDiscoveryQuery("mdns", answer)).toBe(false);
    expect(validDiscoveryQuery("ssdp", ssdp)).toBe(true);
    expect(validDiscoveryQuery("ssdp", Buffer.from("NOTIFY * HTTP/1.1\r\n"))).toBe(false);
    expect(validDiscoveryQuery("ssdp", Buffer.alloc(1300))).toBe(false);
  });
  it("validates tunnel frames and forbids oversized or injected sessions", () => {
    const msg = encodeDiscoveryEnvelope({kind:"query", session:"a".repeat(24), protocol:"mdns", payload:mdns});
    expect(decodeDiscoveryEnvelope(msg)).toMatchObject({kind:"query",session:"a".repeat(24),protocol:"mdns"});
    expect(decodeDiscoveryEnvelope(Buffer.from('{"version":1,"kind":"query","session":"../..","payload":"AA=="}'))).toBeUndefined();
    expect(decodeDiscoveryEnvelope(Buffer.alloc(5000))).toBeUndefined();
  });
  it("limits per-application multicast query rate and scopes RP overlays", () => {
    const limit = new DiscoveryRateLimiter();
    expect(Array.from({length:8}, () => limit.canSend("10.200.0.2",100)).every(Boolean)).toBe(true);
    expect(limit.canSend("10.200.0.2",100)).toBe(false);
    expect(limit.canSend("10.200.0.2",1100)).toBe(true);
    expect(isAttachedOverlaySource("10.200.0.2",["10.200.0.0/24"])).toBe(true);
    expect(isAttachedOverlaySource("10.200.1.2",["10.200.0.0/24"])).toBe(false);
  });
});
