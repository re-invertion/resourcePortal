import { describe, expect, it } from "vitest";
import { couldDeploymentStillMountVolume, type VolumeDeploymentGroup } from "./deployed-volume-reference";

const id = "volume-a";
const snapshot = (volumeIds: string[]) => JSON.stringify({
  singleApps: [{ volumes: volumeIds.map((volumeId) => ({ volumeId })) }],
});
function group(current: string[], old: string[] = []): VolumeDeploymentGroup {
  return {
    currentDeploymentVersion: 2, driftStatus: "InSync",
    lastObservedAt: new Date("2026-10-10T12:30:00Z"),
    deployments: [
      { version: 1, status: "Succeeded", stackConfig: snapshot(old),
        completedAt: new Date("2026-10-09T12:00:00Z") },
      { version: 2, status: "Succeeded", stackConfig: snapshot(current),
        completedAt: new Date("2026-10-10T12:00:00Z") },
    ],
  };
}

describe("deployed volume deletion protection (#254)", () => {
  it("rejects deletion after draft detach while deployed snapshot still mounts volume", () => {
    expect(couldDeploymentStillMountVolume([group([id])], id)).toBe(true);
  });
  it("permits deletion only after new deployment removes volume and runtime converges", () => {
    expect(couldDeploymentStillMountVolume([group([], [id])], id)).toBe(false);
    expect(couldDeploymentStillMountVolume([{
      ...group([], [id]), driftStatus: "Drifted",
    }], id)).toBe(true);
    expect(couldDeploymentStillMountVolume([{
      ...group([], [id]), lastObservedAt: new Date("2026-10-10T11:59:59Z"),
    }], id)).toBe(true);
  });
  it("blocks active deployments, rollbacks, and ambiguous snapshots", () => {
    for (const status of ["Pending", "Deploying", "RollingBack", "RollbackFailed"]) {
      expect(couldDeploymentStillMountVolume([{
        ...group([]), deployments: [...group([]).deployments, {
          version: 3, status, stackConfig: snapshot([]),
        }],
      }], id)).toBe(true);
    }
    expect(couldDeploymentStillMountVolume([{
      ...group([]), deployments: [
        { version: 2, status: "Succeeded", stackConfig: "{broken json" },
      ],
    }], id)).toBe(true);
    expect(couldDeploymentStillMountVolume([{
      ...group([]), deployments: [],
    }], id)).toBe(true);
  });
  it("does not treat detached drafts or historical volumes as active after convergence", () => {
    expect(couldDeploymentStillMountVolume([], id)).toBe(false);
    expect(couldDeploymentStillMountVolume([group(["other-volume"])], id)).toBe(false);
    expect(couldDeploymentStillMountVolume([group([], [id])], id)).toBe(false);
  });
});
