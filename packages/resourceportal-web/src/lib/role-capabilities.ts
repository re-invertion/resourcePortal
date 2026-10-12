export const inviteCapabilities = [
  { name: "View tenant", permission: "tenant.read" },
  { name: "Manage applications", permission: "appgroup.update" },
  { name: "Deploy applications", permission: "appgroup.deploy" },
  { name: "View billing", permission: "billing.read" },
  { name: "Manage members", permission: "membership.invite" },
] as const;

export function capabilityStatus(role: Record<string, unknown> | undefined, permission: string): "Allowed" | "Not granted" | "Unknown" {
  if (!role || !Array.isArray(role.permissions)) return "Unknown";
  const allowed = role.permissions as unknown[];
  return allowed.includes("*") || allowed.includes(permission) ? "Allowed" : "Not granted";
}
