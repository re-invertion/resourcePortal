import { describe, expect, it } from "vitest";
import { belongsToAppGroup } from "./activity-scope";

const appIds = new Set(["app-a"]);
const deploymentIds = new Set(["deploy-a"]);
describe("AppGroup activity operation scope", () => {
  it("includes operations associated with the group and its children", () => {
    expect(belongsToAppGroup({ resourceType: "AppGroup", resourceId: "group-a" }, "group-a", appIds, deploymentIds)).toBe(true);
    expect(belongsToAppGroup({ resourceType: "SingleApp", resourceId: "app-a" }, "group-a", appIds, deploymentIds)).toBe(true);
    expect(belongsToAppGroup({ resourceType: "AppGroupDeployment", resourceId: "deploy-a" }, "group-a", appIds, deploymentIds)).toBe(true);
  });
  it("rejects unrelated groups, child apps, domains and unscoped operations", () => {
    for (const op of [
      { resourceType: "AppGroup", resourceId: "group-b" },
      { resourceType: "SingleApp", resourceId: "app-b" },
      { resourceType: "AppGroupDeployment", resourceId: "deploy-b" },
      { resourceType: "Domain", resourceId: "domain-a" },
      { resourceType: "AppGroup" },
      {},
      { appGroupId: "group-b", resourceType: "AppGroup", resourceId: "group-a" },
    ]) expect(belongsToAppGroup(op, "group-a", appIds, deploymentIds)).toBe(false);
  });
});
