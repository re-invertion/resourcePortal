/**
 * The draft VolumeAttachment collection is not the effective runtime mount list.
 * Work from persisted deployment snapshots and fail closed when their state is
 * incomplete. A detached draft does not remove a mount in an already deployed
 * Docker service.
 */
export type PersistedDeployment = {
  version: number;
  status: string;
  stackConfig: string | null;
  completedAt?: Date | null;
};

export type VolumeDeploymentGroup = {
  currentDeploymentVersion: number | null;
  driftStatus?: string;
  lastObservedAt?: Date | null;
  deployments: PersistedDeployment[];
};

const IN_FLIGHT = new Set(["Pending", "Deploying", "RollingBack", "RollbackFailed"]);

function snapshotReferencesVolume(stackConfig: string | null, volumeId: string): boolean | "unknown" {
  if (!stackConfig) return "unknown";
  try {
    const data: unknown = JSON.parse(stackConfig);
    if (!data || typeof data !== "object" || !("singleApps" in data) ||
        !Array.isArray(data.singleApps)) return "unknown";
    const apps: unknown[] = data.singleApps;
    for (const app of apps) {
      if (!app || typeof app !== "object" || !("volumes" in app) ||
          !Array.isArray(app.volumes)) return "unknown";
      const attachments: unknown[] = app.volumes;
      for (const attachment of attachments) {
        if (!attachment || typeof attachment !== "object" ||
            !("volumeId" in attachment) || typeof attachment.volumeId !== "string")
          return "unknown";
        if (attachment.volumeId === volumeId) return true;
      }
    }
    return false;
  } catch {
    return "unknown";
  }
}

/**
 * True if deleting might remove storage for a mounted or soon-to-be-mounted task.
 * Historical mounts require evidence of a later converged deployment without V.
 */
export function couldDeploymentStillMountVolume(
  groups: VolumeDeploymentGroup[],
  volumeId: string,
): boolean {
  for (const group of groups) {
    if (group.deployments.some((deployment) => IN_FLIGHT.has(deployment.status))) {
      return true; // concurrent deploy/rollback: never delete
    }
    if (group.currentDeploymentVersion === null) continue;
    const current = group.deployments.find((d) => d.version === group.currentDeploymentVersion);
    if (!current || current.status !== "Succeeded") return true;
    const currentReference = snapshotReferencesVolume(current.stackConfig, volumeId);
    if (currentReference !== false) return true;

    const hadHistoricalMount = group.deployments.some((d) =>
      d.version !== current.version && snapshotReferencesVolume(d.stackConfig, volumeId) !== false
    );
    if (hadHistoricalMount && (
      group.driftStatus !== "InSync" ||
      !current.completedAt ||
      !group.lastObservedAt ||
      group.lastObservedAt.getTime() < current.completedAt.getTime()
    )) return true;
  }
  return false;
}
