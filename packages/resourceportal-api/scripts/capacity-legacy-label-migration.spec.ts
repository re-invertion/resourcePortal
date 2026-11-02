import { describe, expect, it } from "vitest";
import { planHash, serviceName, validateLegacyService } from "./capacity-legacy-label-migration";

type Live = Parameters<typeof validateLegacyService>[0];
type Identity = Parameters<typeof validateLegacyService>[1];
const tenantId = "11111111-1111-4111-8111-111111111111";
const appGroupId = "22222222-2222-4222-8222-222222222222";
const singleAppId = "33333333-3333-4333-8333-333333333333";
const identity: Identity = {
  serviceId: "swarm-service-immutable-id",
  serviceName: serviceName(appGroupId, "immich-worker"),
  tenantId, appGroupId, singleAppId,
};
function runtime(labels: Record<string, string> = {}): Live {
  return {
    ID: identity.serviceId,
    Version: { Index: 42 },
    Spec: {
      Name: identity.serviceName,
      Labels: { "com.docker.stack.namespace": `rp_${appGroupId.replaceAll("-", "_")}` },
      Mode: { Replicated: { Replicas: 3 } },
      TaskTemplate: { ContainerSpec: { Image: "registry.local/app:1@sha256:abcdef", Labels: labels } },
    },
  };
}

describe("legacy Hybrid Capacity label migration validation", () => {
  it("allows only a published AppGroup's exact Swarm service and image", () => {
    expect(validateLegacyService(runtime(), identity, "registry.local/app:1")).toBe("migrate");
    expect(serviceName(appGroupId, "name-with-dashes")).toContain("_name_with_dashes");
  });
  it("skips already compliant task templates without restarting replicas", () => {
    expect(validateLegacyService(runtime({ "resourceportal.single-app-id": singleAppId }), identity, "registry.local/app:1")).toBe("skip");
  });
  it("rejects a spoofed service name, namespace or service ID", () => {
    expect(() => validateLegacyService({ ...runtime(), ID: "other-id" }, identity, "registry.local/app:1")).toThrow("Service identity changed");
    const live = runtime();
    live.Spec.Labels = { "com.docker.stack.namespace": "unmanaged" };
    expect(() => validateLegacyService(live, identity, "registry.local/app:1")).toThrow("does not belong");
  });
  it("rejects conflicts on service labels and container labels, including tenant spoofing", () => {
    expect(() => validateLegacyService(runtime({ "resourceportal.single-app-id": "another-app" }), identity, "registry.local/app:1")).toThrow("Conflicting RP ownership");
    expect(() => validateLegacyService(runtime({ "resourceportal.tenant-id": "another-tenant" }), identity, "registry.local/app:1")).toThrow("Conflicting RP ownership");
    const live = runtime();
    live.Spec.Labels!["resourceportal.app-group-id"] = "another-group";
    expect(() => validateLegacyService(live, identity, "registry.local/app:1")).toThrow("Conflicting RP ownership");
  });
  it("rejects changed runtime images and invalid replication policies", () => {
    expect(() => validateLegacyService(runtime(), identity, "registry.local/app:2")).toThrow("Live image differs");
    const live = runtime();
    live.Spec.Mode = { Replicated: { Replicas: 0 } };
    expect(() => validateLegacyService(live, identity, "registry.local/app:1")).toThrow("Only active replicated");
  });
  it("hashes all plan coordinates deterministically to force fresh approval", () => {
    expect(planHash([])).toMatch(/^[a-f0-9]{64}$/);
    expect(planHash([])).toBe(planHash([]));
    expect(planHash([{ serviceVersion: 1 }] as never)).not.toBe(planHash([{ serviceVersion: 2 }] as never));
  });
});
