import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../api/client";
import type { AppRoute } from "../router/router";
import { applicationHref, appGroupHref, platformHref, tenantHref, tenantResourceHref } from "../router/router";

type Route = Extract<AppRoute, { kind: "tenant" | "platform" }>;
type Crumb = { label: string; href: string };
type Labels = { group?: string; app?: string; resource?: string; operation?: string };

function records(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  for (const key of ["items", "data", "results"]) {
    if (Array.isArray(object[key])) return records(object[key]);
  }
  return [];
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function resourceName(value: Record<string, unknown> | undefined, fallback: string) {
  if (!value) return fallback;
  return stringValue(
    value.displayName,
    stringValue(
      value.name,
      stringValue(
        value.hostname,
        stringValue(value.fqdn, stringValue(value.prefix, fallback)),
      ),
    ),
  );
}

function titleCase(value: string) {
  return value
    .replaceAll("-", " ")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function appEditLabel(section?: string) {
  const labels: Record<string, string> = {
    basics: "Basics",
    compute: "Runtime",
    environment: "Environment",
    configuration: "Configuration",
    storage: "Storage",
    networking: "Networking",
    advanced: "Advanced",
  };
  return labels[section || "basics"] ?? titleCase(section || "basics");
}

function tenantCrumbs(route: Extract<Route, { kind: "tenant" }>, labels: Labels): Crumb[] {
  const tenantId = route.tenantId;
  const section = route.section;
  const segments = route.segments ?? [];
  const root: Crumb = { label: "Tenant", href: tenantHref(tenantId, "overview") };

  if (section === "overview") return [root, { label: "Overview", href: tenantHref(tenantId, "overview") }];

  if (section === "applications") {
    const crumbs = [root, { label: "Applications", href: tenantHref(tenantId, "applications") }];
    if (segments[0] === "new") crumbs.push({ label: "Create App Group", href: tenantHref(tenantId, "applications", "new") });
    return crumbs;
  }

  if (section === "app-groups") {
    const groupId = segments[0] ?? route.resourceId;
    const crumbs: Crumb[] = [root, { label: "Applications", href: tenantHref(tenantId, "applications") }];
    if (!groupId) return crumbs;

    const groupHref = appGroupHref(tenantId, groupId);
    crumbs.push({ label: labels.group || "App Group", href: groupHref });

    const sub = segments.slice(1);
    const groupSection = sub[0] || "overview";
    if (groupSection === "overview") return crumbs;

    if (groupSection === "apps") {
      crumbs.push({ label: "Apps", href: appGroupHref(tenantId, groupId, "apps") });
      const appId = sub[1];
      if (!appId) return crumbs;
      if (appId === "new") {
        crumbs.push({ label: "Create application", href: appGroupHref(tenantId, groupId, "apps/new") });
        return crumbs;
      }

      crumbs.push({
        label: labels.app || "Application",
        href: applicationHref(tenantId, groupId, appId),
      });

      if (sub[2] === "edit") {
        crumbs.push({
          label: "Edit",
          href: applicationHref(tenantId, groupId, appId, "edit"),
        });
        if (sub[3]) {
          crumbs.push({
            label: appEditLabel(sub[3]),
            href: applicationHref(tenantId, groupId, appId, `edit/${sub[3]}`),
          });
        }
      } else if (sub[2] === "health") {
        crumbs.push({
          label: "Health",
          href: applicationHref(tenantId, groupId, appId, "health"),
        });
      }
      return crumbs;
    }

    const groupSections: Record<string, string> = {
      config: "Configuration",
      networking: "Networking",
      deployments: "Deployments",
      activity: "Activity",
      settings: "Settings & Advanced",
      advanced: "Settings & Advanced",
    };
    crumbs.push({
      label: groupSections[groupSection] ?? titleCase(groupSection),
      href: appGroupHref(tenantId, groupId, groupSection === "advanced" ? "settings" : groupSection),
    });
    return crumbs;
  }

  if (["storage-networking", "volumes", "registries", "domains"].includes(section)) {
    const crumbs: Crumb[] = [
      root,
      { label: "Storage & Networking", href: tenantHref(tenantId, "storage-networking") },
    ];
    if (section === "storage-networking") return crumbs;

    const names: Record<string, string> = {
      volumes: "Volumes",
      registries: "Registries",
      domains: "Domains",
    };
    crumbs.push({ label: names[section], href: tenantHref(tenantId, section) });

    if (route.resourceId && (section === "registries" || section === "domains")) {
      crumbs.push({
        label: labels.resource || (section === "registries" ? "Registry" : "Domain"),
        href: tenantHref(tenantId, section, route.resourceId),
      });
    }
    return crumbs;
  }

  if (["access", "administration", "credentials", "identity-providers", "groups"].includes(section)) {
    const crumbs: Crumb[] = [
      root,
      { label: "Access", href: tenantHref(tenantId, "access") },
    ];
    if (section === "access") return crumbs;
    const labelsBySection: Record<string, string> = {
      administration: "Administration",
      credentials: "Credentials",
      "identity-providers": "Identity providers",
      groups: "Groups",
    };
    crumbs.push({ label: labelsBySection[section] ?? titleCase(section), href: tenantHref(tenantId, section) });
    return crumbs;
  }

  if (["activity", "operations", "audit"].includes(section)) {
    const crumbs: Crumb[] = [
      root,
      { label: "Activity", href: tenantHref(tenantId, "activity") },
    ];
    if (section === "activity") return crumbs;

    if (section === "operations") {
      crumbs.push({ label: "Operations", href: tenantHref(tenantId, "operations") });
      if (route.resourceId) {
        crumbs.push({
          label: labels.operation || "Operation detail",
          href: tenantHref(tenantId, "operations", route.resourceId),
        });
      }
      return crumbs;
    }

    crumbs.push({ label: "Audit log", href: tenantHref(tenantId, "audit") });
    return crumbs;
  }

  if (section === "billing") return [root, { label: "Billing", href: tenantHref(tenantId, "billing") }];
  if (section === "settings") return [root, { label: "Settings", href: tenantHref(tenantId, "settings") }];
  if (section === "help") return [root, { label: "Help", href: tenantHref(tenantId, "help") }];

  return [root, { label: titleCase(section), href: tenantResourceHref(tenantId, section, ...segments) }];
}

function platformCrumbs(route: Extract<Route, { kind: "platform" }>): Crumb[] {
  const root: Crumb = { label: "Platform Admin", href: platformHref("overview") };
  const section = route.section;
  const segments = route.segments ?? [];

  if (section === "overview") return [root, { label: "Overview", href: platformHref("overview") }];
  if (section === "tenants") return [root, { label: "Tenants", href: platformHref("tenants") }];

  if (section === "infrastructure" || section === "storage-backends") {
    const crumbs: Crumb[] = [root, { label: "Infrastructure", href: platformHref("infrastructure") }];
    if (section === "storage-backends" || segments[0] === "storage-backends") {
      crumbs.push({ label: "Storage backends", href: platformHref("infrastructure", "storage-backends") });
    }
    return crumbs;
  }

  if (section === "identity" || section === "identity-providers" || section === "credentials") {
    const crumbs: Crumb[] = [root, { label: "Identity", href: platformHref("identity") }];
    if (section === "identity") return crumbs;
    crumbs.push({
      label: section === "credentials" ? "Credentials" : "Identity providers",
      href: platformHref(section),
    });
    return crumbs;
  }

  if (section === "security" || section === "operations" || section === "audit") {
    const crumbs: Crumb[] = [root, { label: "Security & Ops", href: platformHref("security") }];
    if (section !== "security") {
      crumbs.push({ label: section === "audit" ? "Audit" : "Operations", href: platformHref(section) });
    }
    return crumbs;
  }

  const labels: Record<string, string> = {
    billing: "Billing",
    maintenance: "Maintenance",
    dns: "DNS & Domains",
    "network-egress": "Network Egress",
  };
  return [root, { label: labels[section] ?? titleCase(section), href: platformHref(section, ...segments) }];
}

export function RouteBreadcrumbs({ route }: { route: Route }) {
  const [labels, setLabels] = useState<Labels>({});

  const routeKey = route.kind === "tenant"
    ? `tenant:${route.tenantId}:${route.section}:${(route.segments ?? []).join("/")}`
    : `platform:${route.section}:${(route.segments ?? []).join("/")}`;

  useEffect(() => {
    let cancelled = false;
    setLabels({});

    async function load() {
      if (route.kind !== "tenant") return;

      const tenantId = route.tenantId;
      const segments = route.segments ?? [];

      if (route.section === "app-groups") {
        const groupId = segments[0] ?? route.resourceId;
        if (!groupId) return;

        const root = `/api/tenants/${encodeURIComponent(tenantId)}/app-groups/${encodeURIComponent(groupId)}`;
        const next: Labels = {};

        try {
          const group = await apiRequest<Record<string, unknown>>(root);
          next.group = resourceName(group, "App Group");
        } catch {
          next.group = "App Group";
        }

        const appId = segments[1] === "apps" ? segments[2] : undefined;
        if (appId && appId !== "new") {
          try {
            const apps = records(await apiRequest(`${root}/single-apps`));
            const app = apps.find((item) => stringValue(item.id) === appId);
            next.app = resourceName(app, "Application");
          } catch {
            next.app = "Application";
          }
        }

        if (!cancelled) setLabels(next);
        return;
      }

      if ((route.section === "registries" || route.section === "domains") && route.resourceId) {
        try {
          const resource = await apiRequest<Record<string, unknown>>(
            `/api/tenants/${encodeURIComponent(tenantId)}/${route.section}/${encodeURIComponent(route.resourceId)}`,
          );
          if (!cancelled) setLabels({ resource: resourceName(resource, route.section === "registries" ? "Registry" : "Domain") });
        } catch {
          if (!cancelled) setLabels({ resource: route.section === "registries" ? "Registry" : "Domain" });
        }
        return;
      }

      if (route.section === "operations" && route.resourceId) {
        try {
          const operation = await apiRequest<Record<string, unknown>>(
            `/api/tenants/${encodeURIComponent(tenantId)}/operations/${encodeURIComponent(route.resourceId)}`,
          );
          const label = titleCase(stringValue(operation.type, stringValue(operation.operationType, "Operation detail")));
          if (!cancelled) setLabels({ operation: label });
        } catch {
          if (!cancelled) setLabels({ operation: "Operation detail" });
        }
      }
    }

    void load();
    return () => { cancelled = true; };
  }, [routeKey]);

  const crumbs = useMemo(
    () => route.kind === "tenant" ? tenantCrumbs(route, labels) : platformCrumbs(route),
    [routeKey, labels],
  );

  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 overflow-hidden text-[12px] font-medium text-[#66758A]">
      {crumbs.map((crumb, index) => (
        <span key={`${crumb.href}-${index}`} className="flex min-w-0 items-center gap-1.5">
          {index > 0 ? <span aria-hidden="true" className="shrink-0 text-[#A0AABA]">/</span> : null}
          <a
            href={crumb.href}
            aria-current={index === crumbs.length - 1 ? "page" : undefined}
            className={`min-w-0 truncate rounded px-1 py-0.5 transition hover:bg-[#EEF3F9] hover:text-[#0F56A7] ${index === crumbs.length - 1 ? "text-[#344054]" : "text-[#66758A]"}`}
            title={crumb.label}
          >
            {crumb.label}
          </a>
        </span>
      ))}
    </nav>
  );
}