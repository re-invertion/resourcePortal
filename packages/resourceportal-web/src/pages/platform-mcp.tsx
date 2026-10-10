import { Card, Callout, PageHeader, StatusText } from "../components/design-system";
import { useApi } from "../hooks/use-api";

export function PlatformMcpPage() {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const mcpUrl = origin ? `${origin}/api/platform/mcp` : "/api/platform/mcp";
  const tools = useApi<{ items: Array<{ name: string; title: string; description: string }> }>("/api/platform/mcp-catalog");

  return <main>
    <PageHeader
      eyebrow="Platform Admin"
      title="Platform Admin MCP"
      description="Connect MCP clients to the dedicated ResourcePortal platform-administration endpoint."
    />
    <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
      <Card className="overflow-hidden">
        <div className="border-b border-[#E1E7F0] px-5 py-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-semibold">MCP connection</h2>
              <p className="mt-1 text-sm text-[#5B6678]">Use this endpoint only for platform administration.</p>
            </div>
            <StatusText tone="success">Available</StatusText>
          </div>
        </div>
        <div className="space-y-5 p-5">
          <div>
            <p className="text-xs font-medium text-[#718096]">MCP server URL</p>
            <code className="mt-1 block break-all rounded-md bg-[#F3F6FA] p-3 text-xs">{mcpUrl}</code>
          </div>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div className="rounded-lg border border-[#D7E0EC] bg-[#F8FAFD] p-3"><dt className="text-xs text-[#718096]">Transport</dt><dd className="mt-1 font-medium">Streamable HTTP</dd></div>
            <div className="rounded-lg border border-[#D7E0EC] bg-[#F8FAFD] p-3"><dt className="text-xs text-[#718096]">Authentication</dt><dd className="mt-1 font-medium">OAuth / Platform Admin</dd></div>
            <div className="rounded-lg border border-[#D7E0EC] bg-[#F8FAFD] p-3"><dt className="text-xs text-[#718096]">Tool prefix</dt><dd className="mt-1 font-medium">resourceportal_admin_*</dd></div>

          </dl>
          <Callout title="Separate from Tenant MCP">
            Platform Admin MCP exposes explicit platform-management tools. It does not bypass tenant RBAC and does not provide generic shell, filesystem, SQL or tenant workload administration.
          </Callout>
        </div>
      </Card>
      <Card className="p-5">
        <h2 className="font-semibold">What it manages</h2>
        <ul className="mt-3 space-y-2 text-sm text-[#526070]">
          <li>Platform health, Swarm and remote locations</li>
          <li>Storage backends, maintenance and network egress</li>
          <li>DNS, email, identity providers and OAuth applications</li>
          <li>Billing administration, ResourceBot and Bug Reports</li>
          <li>Read-only platform tenant and user directories</li>
        </ul>
      </Card>
    </div>
    <Card className="mt-5 overflow-hidden"><div className="border-b border-[#E1E7F0] px-5 py-4"><h2 className="font-semibold">Available Platform Admin MCP tools</h2><p className="mt-1 text-xs text-[#718096]">Current server-side tool catalog. {tools.data?.items?.length ?? 0} tools.</p></div>{tools.loading?<p className="p-5 text-sm">Loading tools…</p>:tools.error?<p className="p-5 text-sm text-[#B42318]">Tool catalog unavailable.</p>:<div className="max-h-[480px] divide-y divide-[#E1E7F0] overflow-y-auto">{tools.data?.items?.map(tool=><div key={tool.name} className="px-5 py-3"><strong className="block break-all text-[13px]">{tool.name}</strong><p className="mt-1 text-xs text-[#526070]">{tool.description}</p></div>)}</div>}</Card>
  </main>;
}
