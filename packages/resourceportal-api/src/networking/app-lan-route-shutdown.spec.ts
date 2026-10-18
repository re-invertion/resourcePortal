import { describe, expect, it } from "vitest";
import { managedRouteFlushArgs, managedTenantRoutePids } from "./app-lan-route-shutdown";

describe("fail-safe route-agent shutdown", () => {
  it("selects only running tenant namespaces and de-duplicates PIDs", () => {
    const tenant = { State: { Running: true, Pid: 101 },
      Config: { Labels: { "resourceportal.workload": "tenant" } },
      HostConfig: { NetworkMode: "default" },
      NetworkSettings: { Networks: {
        "rp-network-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee": {},
      } },
    };
    expect(managedTenantRoutePids([
      tenant, tenant,
      { ...tenant, State: { Running: false, Pid: 102 } },
      { ...tenant, State: { Running: true, Pid: 1 } },
      { ...tenant, Config: { Labels: { "resourceportal.workload": "platform" } } },
      { ...tenant, HostConfig: { NetworkMode: "host" } },
      { ...tenant, NetworkSettings: { Networks: { host: {} } } },
      { State: { Running: true, Pid: 500 } }, {}, null,
    ])).toEqual([101]);
    expect(() => managedTenantRoutePids({})).toThrow();
  });
  it("flushes only RP-owned protocol routes rather than the app default route", () => {
    expect(managedRouteFlushArgs()).toEqual(["-4", "route", "flush", "proto", "201"]);
  });
});
