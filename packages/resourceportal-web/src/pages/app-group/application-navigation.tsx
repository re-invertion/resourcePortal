import { Tabs } from "../../components/design-system";
import { applicationHref } from "../../router/router";

export type ApplicationSection =
  | "overview"
  | "runtime"
  | "configuration"
  | "storage"
  | "networking"
  | "health"
  | "advanced";

export function ApplicationNavigation({
  tenantId,
  appGroupId,
  appId,
  active,
}: {
  tenantId: string;
  appGroupId: string;
  appId: string;
  active?: ApplicationSection;
}) {
  return (
    <Tabs
      label="Application sections"
      items={[
        {
          label: "Overview",
          href: applicationHref(tenantId, appGroupId, appId),
          active: active === "overview",
        },
        {
          label: "Runtime",
          href: applicationHref(tenantId, appGroupId, appId, "edit/compute"),
          active: active === "runtime",
        },
        {
          label: "Configuration",
          href: applicationHref(
            tenantId,
            appGroupId,
            appId,
            "edit/configuration",
          ),
          active: active === "configuration",
        },
        {
          label: "Storage",
          href: applicationHref(tenantId, appGroupId, appId, "edit/storage"),
          active: active === "storage",
        },
        {
          label: "Networking",
          href: applicationHref(tenantId, appGroupId, appId, "edit/networking"),
          active: active === "networking",
        },
        {
          label: "Health",
          href: applicationHref(tenantId, appGroupId, appId, "health"),
          active: active === "health",
        },
        {
          label: "Settings / Advanced",
          href: applicationHref(tenantId, appGroupId, appId, "edit/advanced"),
          active: active === "advanced",
        },
      ]}
    />
  );
}
