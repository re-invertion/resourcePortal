import { Tabs } from "./design-system";
import { tenantHref } from "../router/router";



export function StorageTabs({
  tenantId,
  active,
}: {
  tenantId: string;
  active: "volumes" | "registries";
}) {
  return (
    <Tabs
      label="Storage sections"
      items={[
        {
          label: "Volumes",
          href: tenantHref(tenantId, "volumes"),
          active: active === "volumes",
        },
        {
          label: "Registries",
          href: tenantHref(tenantId, "registries"),
          active: active === "registries",
        },
      ]}
    />
  );
}

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
          label: "Networks & VPN",
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
  active: "overview" | "administration" | "credentials" | "identity-sso";
}) {
  return (
    <Tabs
      label="Access sections"
      items={[
        {
          label: "Members & invitations",
          href: tenantHref(tenantId, "access"),
          active: active === "overview",
        },
        {
          label: "Roles & groups",
          href: tenantHref(tenantId, "administration"),
          active: active === "administration",
        },
        {
          label: "Integrations",
          href: tenantHref(tenantId, "credentials"),
          active: active === "credentials",
        },
        {
          label: "Identity & SSO",
          href: tenantHref(tenantId, "identity-sso"),
          active: active === "identity-sso",
        },
      ]}
    />
  );
}