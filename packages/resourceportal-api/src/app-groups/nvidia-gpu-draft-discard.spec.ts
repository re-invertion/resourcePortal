import { describe, expect, it } from "vitest";
import { assertGpuDraftHasNoDeploymentHistory } from "./nvidia-gpu-draft-discard";

const GPU_APP = "11111111-1111-4111-8111-111111111111";
const OTHER_APP = "22222222-2222-4222-8222-222222222222";
const attempt = (appIds: string[]) => ({
  stackConfig: JSON.stringify({ singleApps: appIds.map((id) => ({ id })) }),
});

describe("GPU draft discard only releases never-deployed devices", () => {
  it("permits deleting a GPU allocation created purely as an undeployed draft", () => {
    expect(() => assertGpuDraftHasNoDeploymentHistory([GPU_APP], [
      attempt([OTHER_APP]),
    ])).not.toThrow();
    expect(() => assertGpuDraftHasNoDeploymentHistory([GPU_APP], [])).not.toThrow();
  });

  it("blocks release when even a failed candidate may have started the GPU app", () => {
    expect(() => assertGpuDraftHasNoDeploymentHistory([GPU_APP], [
      attempt([OTHER_APP]), attempt([GPU_APP]),
    ])).toThrow("GpuDraftDiscardRequiresVerifiedRuntimeCleanup");
  });

  it("fails closed for malformed or unavailable rollout history", () => {
    for (const stackConfig of [null, "", "{bad", "{}", '{"singleApps":[null]}']) {
      expect(() => assertGpuDraftHasNoDeploymentHistory([GPU_APP], [
        { stackConfig },
      ])).toThrow("GpuDraftDiscardRequiresVerifiedRuntimeCleanup");
    }
  });

  it("does not interrupt conventional CPU-only draft discards", () => {
    expect(() => assertGpuDraftHasNoDeploymentHistory([], [
      { stackConfig: null },
    ])).not.toThrow();
  });
});
