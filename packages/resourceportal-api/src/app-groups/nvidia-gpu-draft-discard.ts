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

/**
 * A pre-existing CPU-only app may have a new, draft-only dedicated GPU claim.
 * Its app ID necessarily occurs in previous successful deployments; in this
 * case compare historic *GPU usage* instead of rejecting every historic ID.
 * Unknown/legacy snapshots are insufficient evidence and must fail closed.
 */
export function assertGpuExistingAppsNeverAttemptedGpuRuntime(
  appIds: readonly string[],
  deployments: readonly { stackConfig: string | null }[],
) {
  const allocated = new Set(appIds);
  if (!allocated.size) return;
  if (!deployments.length) {
    throw new ConflictException("GpuDraftDiscardRequiresVerifiedRuntimeCleanup");
  }
  const observed = new Set<string>();
  for (const deployment of deployments) {
    let stack: unknown;
    try {
      stack = JSON.parse(deployment.stackConfig ?? "") as unknown;
    } catch {
      throw new ConflictException("GpuDraftDiscardRequiresVerifiedRuntimeCleanup");
    }
    if (!stack || typeof stack !== "object" || !("singleApps" in stack) ||
        !Array.isArray(stack.singleApps)) {
      throw new ConflictException("GpuDraftDiscardRequiresVerifiedRuntimeCleanup");
    }
    for (const item of stack.singleApps as unknown[]) {
      if (!item || typeof item !== "object" || !("id" in item) ||
          typeof item.id !== "string") {
        throw new ConflictException("GpuDraftDiscardRequiresVerifiedRuntimeCleanup");
      }
      if (!allocated.has(item.id)) continue;
      observed.add(item.id);
      if (!("resources" in item) || !item.resources ||
          typeof item.resources !== "object" ||
          !("gpu" in item.resources) || item.resources.gpu !== 0 ||
          ("gpuUuid" in item.resources &&
           item.resources.gpuUuid !== null && item.resources.gpuUuid !== undefined)) {
        throw new ConflictException("GpuDraftDiscardRequiresVerifiedRuntimeCleanup");
      }
    }
  }
  if (observed.size !== allocated.size) {
    throw new ConflictException("GpuDraftDiscardRequiresVerifiedRuntimeCleanup");
  }
}