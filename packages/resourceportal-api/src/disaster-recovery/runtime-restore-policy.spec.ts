import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { deploymentArtifactSha256 } from "../internal/deployment-artifact";
import { runtimeSafeRestoreArtifact } from "./runtime-restore-policy";

const stack = "services:\n  web:\n    image: example/web:4\n    deploy:\n      replicas: 3\n";
const original = { renderedStack: stack, sha256: deploymentArtifactSha256(stack) };
const snapshot = JSON.stringify({
  singleApps: [{ id: "web-id", name: "web", desiredReplicas: 3 }],
});

const live = { singleApps: [{ id: "web-id", runtimeState: "Running", pendingDeletion: false }] };

describe("safe runtime restore preserves current controls (#267)", () => {
  it("retains exact deployment bytes when running and not blocked", () => {
    const result = runtimeSafeRestoreArtifact(original, snapshot, { ...live, blocked: false });
    expect(result).toBe(original);
  });
  it.each(["app explicitly stopped", "pending app deletion", "tenant/billing/maintenance group blocker"])(
    "restores zero replicas for %s instead of resurrecting stopped workloads",
    (scenario) => {
      const context = {
        blocked: scenario === "tenant/billing/maintenance group blocker",
        singleApps: [{
          id: "web-id",
          runtimeState: scenario === "app explicitly stopped" ? "Stopped" : "Running",
          pendingDeletion: scenario === "pending app deletion",
        }],
      };
      const result = runtimeSafeRestoreArtifact(original, snapshot, context);
      const derived = parse(result.renderedStack) as {
        services: { web: { deploy: { replicas: number } } };
      };
      expect(derived.services.web.deploy.replicas).toBe(0);
      expect(result.sha256).toBe(deploymentArtifactSha256(result.renderedStack));
      expect(original.renderedStack).toBe(stack);
      expect(original.sha256).toBe(deploymentArtifactSha256(stack));
    },
  );
  it("fails closed on missing snapshot or service mismatch", () => {
    expect(() => runtimeSafeRestoreArtifact(original, null, { ...live, blocked: true }))
      .toThrow("RuntimeRestoreMissingSnapshot");
    expect(() => runtimeSafeRestoreArtifact(original, JSON.stringify({
      singleApps: [{ id: "x", name: "unexpected", desiredReplicas: 1 }],
    }), { ...live, blocked: true })).toThrow("RuntimeRestoreServiceMismatch");
  });
});
