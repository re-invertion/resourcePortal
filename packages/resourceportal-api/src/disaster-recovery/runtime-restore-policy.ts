import { parse, stringify } from "yaml";
import { deploymentArtifactSha256 } from "../internal/deployment-artifact";

export type RuntimeRestoreContext = {
  blocked: boolean;
  singleApps: Array<{ id: string; runtimeState: string; pendingDeletion: boolean }>;
};

type Snapshot = {
  singleApps: Array<{ id: string; name: string; desiredReplicas: number }>;
};

/**
 * Adapt a verified immutable deployment artifact to CURRENT runtime controls.
 * Never mutate the persisted artifact or silently re-enable a stopped workload.
 */
export function runtimeSafeRestoreArtifact(
  original: { renderedStack: string; sha256: string },
  stackConfig: string | null,
  current: RuntimeRestoreContext,
): { renderedStack: string; sha256: string } {
  if (!stackConfig) throw new Error("RuntimeRestoreMissingSnapshot");
  const snapshot = JSON.parse(stackConfig) as Snapshot;
  if (!Array.isArray(snapshot.singleApps)) throw new Error("RuntimeRestoreInvalidSnapshot");
  const stack = parse(original.renderedStack) as {
    services?: Record<string, { deploy?: { replicas?: number } }>;
  } | null;
  if (!stack?.services || typeof stack.services !== "object") {
    throw new Error("RuntimeRestoreInvalidStack");
  }
  const runtimeById = new Map(current.singleApps.map(app => [app.id, app]));
  const expectedNames = new Set<string>();
  let changed = false;
  for (const app of snapshot.singleApps) {
    if (!app || typeof app.name !== "string" || typeof app.id !== "string" ||
        !Number.isInteger(app.desiredReplicas) || app.desiredReplicas < 0) {
      throw new Error("RuntimeRestoreInvalidSingleApp");
    }
    const name = app.name.replaceAll("-", "_");
    if (expectedNames.has(name) || !Object.hasOwn(stack.services, name)) {
      throw new Error("RuntimeRestoreServiceMismatch");
    }
    expectedNames.add(name);
    const service = stack.services[name];
    if (!service || typeof service !== "object") throw new Error("RuntimeRestoreInvalidService");
    const live = runtimeById.get(app.id);
    const desiredReplicas = current.blocked || !live ||
      live.pendingDeletion || live.runtimeState !== "Running"
      ? 0
      : app.desiredReplicas;
    if (service.deploy?.replicas !== desiredReplicas) {
      service.deploy ??= {};
      service.deploy.replicas = desiredReplicas;
      changed = true;
    }
  }
  if (Object.keys(stack.services).some(name => !expectedNames.has(name))) {
    throw new Error("RuntimeRestoreUnexpectedService");
  }
  if (!changed) return original;
  const renderedStack = stringify(stack, { lineWidth: 0 });
  return { renderedStack, sha256: deploymentArtifactSha256(renderedStack) };
}
