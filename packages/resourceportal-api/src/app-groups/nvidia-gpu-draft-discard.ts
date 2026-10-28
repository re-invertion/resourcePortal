import { ConflictException } from "@nestjs/common";

/**
 * A deleted draft GPU reservation can only be released without a Swarm probe
 * when the app ID was never included in ANY persisted deployment attempt.
 * Failed rollouts may leave orphaned Swarm tasks even after the operation
 * reaches a terminal error state. Unknown snapshots fail closed.
 */
export function assertGpuDraftHasNoDeploymentHistory(
  appIds: readonly string[],
  deployments: readonly { stackConfig: string | null }[],
) {
  const allocated = new Set(appIds);
  if (!allocated.size) return;

  for (const deployment of deployments) {
    if (!deployment.stackConfig) {
      throw new ConflictException("GpuDraftDiscardRequiresVerifiedRuntimeCleanup");
    }
    let stack: unknown;
    try {
      stack = JSON.parse(deployment.stackConfig) as unknown;
    } catch {
      throw new ConflictException("GpuDraftDiscardRequiresVerifiedRuntimeCleanup");
    }
    if (!stack || typeof stack !== "object" || !("singleApps" in stack) ||
        !Array.isArray(stack.singleApps)) {
      throw new ConflictException("GpuDraftDiscardRequiresVerifiedRuntimeCleanup");
    }
    for (const app of stack.singleApps as unknown[]) {
      if (!app || typeof app !== "object" || !("id" in app) ||
          typeof app.id !== "string") {
        throw new ConflictException("GpuDraftDiscardRequiresVerifiedRuntimeCleanup");
      }
      if (allocated.has(app.id)) {
        throw new ConflictException("GpuDraftDiscardRequiresVerifiedRuntimeCleanup");
      }
    }
  }
}
