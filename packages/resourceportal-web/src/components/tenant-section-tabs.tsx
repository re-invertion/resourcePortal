import { Tabs } from "./design-system";
import { tenantHref } from "../router/router";

export function NetworkingTabs({
  tenantId,
  active,
}: {
  tenantId: string;
  active: "networking" | "domains";
}) {
  return (
    <Tabs
      label="Networking sections"
      items={[
        {
          label: "Networks & Gate",
          href: tenantHref(tenantId, "networking"),
          active: active === "networking",
        },
        {
          label: "Domains",
          href: tenantHref(tenantId, "domains"),
          active: active === "domains",
        },
      ]}
    />
  );
}

export function AccessTabs({
  tenantId,
  active,
}: {
  tenantId: string;
  active: "overview" | "administration" | "credentials";
}) {
  return (
    <Tabs
      label="Access sections"
      items={[
        {
          label: "Overview",
          href: tenantHref(tenantId, "access"),
          active: active === "overview",
        },
        {
          label: "Administration",
          href: tenantHref(tenantId, "administration"),
          active: active === "administration",
        },
        {
          label: "Credentials",
          href: tenantHref(tenantId, "credentials"),
          active: active === "credentials",
        },
      ]}
    />
  );
}
