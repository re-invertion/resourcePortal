import { describe, expect, it } from "vitest";
import { desiredRoutesForContainer, validateLanRoutePolicy } from "./app-lan-routes";
const tenantId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const singleAppId = "aaaaaaaa-bbbb-4ccc-8ddd-aaaaaaaaaaaa";
const networkName = "rp-network-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const route = {
  tenantId, singleAppId, networkName,
  swarmServiceName: "rp_aaaaaaaa_bbbb_4ccc_8ddd_eeeeeeeeeeee_mqtt",
  sourceNetworkCidr: "10.200.5.0/24",
  destinationCidr: "192.168.5.10/32",
  gatewayAddress: "10.200.5.200",
};
describe("application LAN route agent policies", () => {
  it("accepts an attached isolated route", () => {
    const rules = validateLanRoutePolicy({ version: 1, routes: [route] });
    expect(desiredRoutesForContainer(rules, {
      "resourceportal.workload": "tenant",
      "resourceportal.tenant-id": tenantId,
      "resourceportal.single-app-id": singleAppId,
    }, { [networkName]: { IPAddress: "10.200.5.25" } })).toEqual([route]);
  });
  it("rejects foreign tenants, unrelated apps, missing overlay", () => {
    const rules = validateLanRoutePolicy({ version: 1, routes: [route] });
    for (const labels of [
      { "resourceportal.workload":"tenant", "resourceportal.tenant-id":"other", "resourceportal.single-app-id":singleAppId },
      { "resourceportal.workload":"tenant", "resourceportal.tenant-id":tenantId, "resourceportal.single-app-id":"other" },
      { "resourceportal.workload":"user", "resourceportal.tenant-id":tenantId, "resourceportal.single-app-id":singleAppId },
    ]) {
      expect(desiredRoutesForContainer(rules, labels, { [networkName]: { IPAddress:"10.200.5.25" } })).toEqual([]);
    }
    expect(desiredRoutesForContainer(rules, {
      "resourceportal.workload":"tenant", "resourceportal.tenant-id":tenantId,
      "resourceportal.single-app-id":singleAppId,
    }, {})).toEqual([]);
  });
  it("supports already deployed workloads without new single-app label", () => {
    const rules = validateLanRoutePolicy({ version: 1, routes: [route] });
    expect(desiredRoutesForContainer(rules, {
      "resourceportal.workload": "tenant",
      "resourceportal.tenant-id": tenantId,
      "com.docker.swarm.service.name": route.swarmServiceName,
    }, { [networkName]: { IPAddress: "10.200.5.25" } })).toEqual([route]);
  });

  it("rejects invalid gateways, broad CIDRs and ambiguous sites", () => {
    expect(() => validateLanRoutePolicy({version:1,routes:[{...route,gatewayAddress:"8.8.8.8"}]})).toThrow();
    expect(() => validateLanRoutePolicy({version:1,routes:[{...route,destinationCidr:"0.0.0.0/0"}]})).toThrow();
    expect(() => validateLanRoutePolicy({version:1,routes:[route,{...route,gatewayAddress:"10.200.5.201"}]})).toThrow();
  });
});
