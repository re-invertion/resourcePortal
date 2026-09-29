import { Callout, LinkButton, PageHeader } from "../components/design-system";
import { PlatformDnsPage } from "./platform-dns";
import { PlatformNetworkEgressPage } from "./platform-network-egress";
import { PlatformResourceBotPage } from "./platform-resource-bot";
import { PlatformBillingPage } from "./platform-billing";
import { PlatformSettingsPage } from "./platform-settings";
import { PlatformBugReportsPage } from "./platform-bug-reports";
import { PlatformCredentialsPage, PlatformIdentityProvidersPage } from "./platform-identity-pages";
import {
  PlatformIdentityPage,
  PlatformInfrastructurePage,
  PlatformMaintenancePage,
  PlatformOverviewPage,
  PlatformSecurityPage,
  PlatformTenantsPage,
  PlatformUsersPage,
} from "./platform-final-pages";

export function PlatformPage({ section, segments }: { section: string; resourceId?: string; segments?: string[] }) {
  if (section === "overview") return <PlatformOverviewPage />;
  if (section === "tenants") return <PlatformTenantsPage />;
  if (section === "users") return <PlatformUsersPage />;
  if (section === "infrastructure" || section === "storage-backends") return <PlatformInfrastructurePage />;
  if (section === "identity") return <PlatformIdentityPage />;
  if (section === "identity-providers") return <PlatformIdentityProvidersPage />;
  if (section === "credentials") return <PlatformCredentialsPage />;
  if (section === "billing") {
    const active = segments?.[0] === "pricing" || segments?.[0] === "vouchers" ? segments[0] : "overview";
    return <PlatformBillingPage activeSection={active} />;
  }
  if (section === "resource-bot") return <PlatformResourceBotPage />;
  if (section === "dns") return <PlatformDnsPage />;
  if (section === "network-egress") return <PlatformNetworkEgressPage />;
  if (section === "security" || section === "operations" || section === "audit") return <PlatformSecurityPage />;
  if (section === "maintenance") return <PlatformMaintenancePage />;
  if (section === "bug-reports") return <PlatformBugReportsPage />;
  if (section === "settings") return <PlatformSettingsPage />;
  return <main><PageHeader eyebrow="Platform Admin" title="Platform page not found" description={`Unknown section: ${section}`} /><Callout tone="warning" title="This Platform Admin route is not available" action={<LinkButton href="/platform/overview">Open overview</LinkButton>}>Use the final Platform Admin navigation to open a supported section.</Callout></main>;
}
