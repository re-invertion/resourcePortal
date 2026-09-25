import { TenantDashboard } from "./tenant-dashboard";
import { ApplicationsPage } from "./applications";
import { CreateAppGroupPage } from "./app-group-create";
import { ImportAppGroupPage } from "./app-group-import";
import { AppGroupRoute } from "./app-group/route";
import { TenantStorageNetworking, TenantAccess, TenantActivity, TenantBilling } from "./tenant-resources";
import { TenantVolumesPage, TenantRegistriesPage, TenantRegistryDetailPage, TenantDomainsPage, TenantDomainDetailPage } from "./tenant-storage-pages";
import { TenantAdministrationPage, TenantCredentialsPage } from "./tenant-access-pages";
import { TenantOperationsPage, TenantAuditPage } from "./tenant-activity-pages";
import { TenantHelpPage } from "./help";
import { TenantSettingsPage } from "./tenant-settings";
import { TenantNetworkingPage } from "./tenant-networking";

type TenantPageProps = {
  tenantId: string;
  section: string;
  resourceId?: string;
  segments?: string[];
  userId: string;
};

export function TenantPage({ tenantId, section, resourceId, segments = [] }: TenantPageProps) {
  if (section === "overview") return <TenantDashboard tenantId={tenantId} />;
  if (section === "applications") {
    if (segments[0] === "new") return <CreateAppGroupPage tenantId={tenantId} />;
    if (segments[0] === "import") return <ImportAppGroupPage tenantId={tenantId} />;
    return <ApplicationsPage tenantId={tenantId} />;
  }
  if (section === "app-groups") return (segments.length || resourceId) ? <AppGroupRoute tenantId={tenantId} segments={segments.length ? segments : [resourceId!]} /> : <ApplicationsPage tenantId={tenantId} />;
  if (section === "storage-networking") return <TenantStorageNetworking tenantId={tenantId} />;
  if (section === "networking") return <TenantNetworkingPage tenantId={tenantId} />;
  if (section === "access") return <TenantAccess tenantId={tenantId} />;
  if (section === "activity") return <TenantActivity tenantId={tenantId} />;
  if (section === "billing") return <TenantBilling tenantId={tenantId} />;
  if (section === "help") return <TenantHelpPage tenantId={tenantId} />;
  if (section === "settings") return <TenantSettingsPage tenantId={tenantId} />;
  if (section === "volumes") return <TenantVolumesPage tenantId={tenantId} />;
  if (section === "registries") return resourceId ? <TenantRegistryDetailPage tenantId={tenantId} registryId={resourceId} /> : <TenantRegistriesPage tenantId={tenantId} />;
  if (section === "domains") return resourceId ? <TenantDomainDetailPage tenantId={tenantId} domainId={resourceId} /> : <TenantDomainsPage tenantId={tenantId} />;
  if (section === "administration") return <TenantAdministrationPage tenantId={tenantId} />;
  if (section === "credentials") return <TenantCredentialsPage tenantId={tenantId} />;
  if (section === "audit") return <TenantAuditPage tenantId={tenantId} />;
  if (section === "operations") return <TenantOperationsPage tenantId={tenantId} operationId={resourceId} />;
  return <main><h1>Tenant page not found</h1><p>Unknown section: {section}</p></main>;
}