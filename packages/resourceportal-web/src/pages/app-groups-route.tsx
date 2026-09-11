import { useEffect, useState } from "react";
import { apiRequest } from "../api/client";
import { AppGroupsPage } from "./app-groups";

function membershipPermissions(value: unknown, userId: string): string[] | undefined {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).items)
      ? (value as Record<string, unknown>).items as unknown[]
      : [];
  const membership = list.find((candidate) => {
    if (!candidate || typeof candidate !== "object") return false;
    const row = candidate as Record<string, unknown>;
    return row.userId === userId
      || (row.user && typeof row.user === "object" && (row.user as Record<string, unknown>).id === userId);
  }) as Record<string, unknown> | undefined;
  if (!membership) return undefined;
  const direct = membership.effectivePermissions ?? membership.permissions;
  if (Array.isArray(direct)) return direct.filter((entry): entry is string => typeof entry === "string");
  if (Array.isArray(membership.roles)) {
    return [...new Set(membership.roles.flatMap((role) =>
      role && typeof role === "object" && Array.isArray((role as Record<string, unknown>).permissions)
        ? (role as Record<string, unknown>).permissions as string[]
        : [],
    ))];
  }
  return undefined;
}

export function AppGroupsRoute({ tenantId, userId }: { tenantId: string; userId: string }) {
  const [permissions, setPermissions] = useState<string[] | undefined>();
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    let active = true;
    const path = `/api/tenants/${encodeURIComponent(tenantId)}/memberships`;
    apiRequest(path)
      .then((value) => {
        if (!active) return;
        setPermissions(membershipPermissions(value, userId));
        setResolved(true);
      })
      .catch(() => {
        if (!active) return;
        setPermissions([]);
        setResolved(true);
      });
    return () => { active = false; };
  }, [tenantId, userId]);

  if (!resolved) return <p className="rp-resource-loading">Loading App Groups…</p>;
  return <AppGroupsPage tenantId={tenantId} permissions={permissions ?? []} />;
}
