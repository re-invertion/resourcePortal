export type OperationResource = {
  appGroupId?: unknown;
  resourceType?: unknown;
  resourceId?: unknown;
};

/** Exact scoped identifiers derived from tenant's App Group, SingleApps and deployment list. */
export function belongsToAppGroup(
  op: OperationResource,
  groupId: string,
  appIds: ReadonlySet<string>,
  deploymentIds: ReadonlySet<string>,
): boolean {
  if (typeof op.appGroupId === "string") return op.appGroupId === groupId;
  const id = typeof op.resourceId === "string" ? op.resourceId : "";
  if (!id) return false;
  if (op.resourceType === "AppGroup") return id === groupId;
  if (op.resourceType === "SingleApp") return appIds.has(id);
  if (op.resourceType === "AppGroupDeployment") return deploymentIds.has(id);
  return false;
}
