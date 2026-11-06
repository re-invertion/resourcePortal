/**
 * Status colors are deliberately derived from exact server enum values.
 * Searching positive substrings in arbitrary status text is unsafe:
 * Unhealthy, Invalid, Inactive and Unavailable otherwise become green.
 *
 * Health, runtime, sync and operation statuses remain separate data fields.
 * Callers must pass the status enum, not a concatenated description.
 */
export type SemanticStatusTone = "success" | "warning" | "danger" | "neutral" | "info";

const statusTones: Readonly<Record<string, SemanticStatusTone>> = {
  healthy: "success", ready: "success", running: "success",
  succeeded: "success", success: "success", active: "success",
  insync: "success", available: "success", completed: "success",
  complete: "success", valid: "success", verified: "success",
  connected: "success", online: "success", passed: "success",
  failed: "danger", error: "danger", unhealthy: "danger",
  blocked: "danger", suspended: "danger", invalid: "danger",
  unavailable: "danger", expired: "danger", rollbackfailed: "danger",
  disconnected: "danger", rejected: "danger", drifted: "danger",
  pending: "warning", validating: "warning", issuing: "warning",
  deploying: "warning", rollingback: "warning", provisioning: "warning",
  warning: "warning", degraded: "warning", queued: "warning",
  inprogress: "warning", updating: "warning", deleting: "warning",
  preparingartifacts: "warning", generatingstack: "warning", applyingstack: "warning",
  waitingforrollout: "warning", cleanup: "warning", creating: "warning", resizing: "warning",
  rolledback: "warning",
  starting: "warning", stopping: "warning", initializing: "warning",
  low: "warning", maintenance: "warning",
  inactive: "neutral", disabled: "neutral", unknown: "neutral",
  stopped: "neutral", notdeployed: "neutral", draft: "neutral",
  paused: "neutral", removed: "neutral", notconfigured: "neutral",
};

/** Unknown/compound descriptions are never classified as a healthy success. */
export function semanticStatusTone(value: unknown): SemanticStatusTone {
  const key = String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  return statusTones[key] ?? "neutral";
}
