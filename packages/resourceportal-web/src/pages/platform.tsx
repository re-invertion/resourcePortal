import { Callout, LinkButton, PageHeader } from "../components/design-system";
import { PlatformDnsPage } from "./platform-dns";
import { PlatformCredentialsPage, PlatformIdentityProvidersPage } from "./platform-identity-pages";
import {
  PlatformBillingPage,
  PlatformIdentityPage,
  PlatformInfrastructurePage,
  PlatformMaintenancePage,
  PlatformOverviewPage,
  PlatformSecurityPage,
  PlatformTenantsPage,
} from "./platform-final-pages";

export function PlatformPage({ section }: { section: string; resourceId?: string; segments?: string[] }) {
  if (section === "overview") return <PlatformOverviewPage />;
  if (section === "tenants") return <PlatformTenantsPage />;
  if (section === "infrastructure" || section === "storage-backends") return <PlatformInfrastructurePage />;
  if (section === "identity") return <PlatformIdentityPage />;
  if (section === "identity-providers") return <PlatformIdentityProvidersPage />;
  if (section === "credentials") return <PlatformCredentialsPage />;
  if (section === "billing") return <PlatformBillingPage />;
  if (section === "dns") return <PlatformDnsPage />;
  if (section === "security" || section === "operations" || section === "audit") return <PlatformSecurityPage />;
  if (section === "maintenance") return <PlatformMaintenancePage />;
  return <main><PageHeader eyebrow="Platform Admin" title="Platform page not found" description={`Unknown section: ${section}`} /><Callout tone="warning" title="This Platform Admin route is not available" action={<LinkButton href="/platform/overview">Open overview</LinkButton>}>Use the final Platform Admin navigation to open a supported section.</Callout></main>;
}
