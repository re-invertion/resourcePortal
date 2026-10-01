import {
  Callout,
  Card,
  DetailList,
  NetworkIcon,
  PageHeader,
  StatusBadge,
} from "../components/design-system";
import { formatDate, useApi } from "../hooks/use-api";

type ReconciliationState = {
  lastSuccessAt?: string | null;
  lastFailureAt?: string | null;
  lastCompletedAt?: string | null;
  lastResult?: { revision?: number; enabled?: boolean } | null;
  lastError?: string | null;
};

type EgressState = {
  enabled: boolean;
  revision: number;
  protectedCidrs: string[];
  updatedAt?: string;
  enforcement?: ReconciliationState | null;
};

export function PlatformNetworkEgressPage() {
  const state = useApi<EgressState>("/api/platform/network-egress");
  const appliedRevision = state.data?.enforcement?.lastResult?.revision;
  const enforcementHealthy = Boolean(
    state.data?.enforcement?.lastSuccessAt &&
      (!state.data.enforcement.lastFailureAt ||
        new Date(state.data.enforcement.lastSuccessAt).getTime() >=
          new Date(state.data.enforcement.lastFailureAt).getTime()),
  );
  const applied =
    enforcementHealthy && appliedRevision === state.data?.revision;

  return (
    <main>
      <PageHeader
        eyebrow="Platform Admin"
        title="Network Egress"
        description="Monitor mandatory isolation that prevents tenant workloads from reaching private datacenter infrastructure outside ResourcePortal-managed tenant Networks."
      />

      {state.error ? (
        <div className="mb-5">
          <Callout tone="danger" title="Network egress policy unavailable">
            {state.error instanceof Error
              ? state.error.message
              : "The platform egress API could not be loaded."}
          </Callout>
        </div>
      ) : null}

      <div className="mb-6 grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(320px,.9fr)]">
        <Card className="p-5">
          <div className="mb-5 flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#E7F1FF] text-[#1769E0]">
              <NetworkIcon size={19} />
            </span>
            <div>
              <h2 className="font-semibold text-[#172033]">Tenant private-network isolation</h2>
              <p className="mt-1 text-xs leading-5 text-[#718096]">
                Applies on every Swarm node. Internet egress and traffic through ResourcePortal-managed Networks remain available.
              </p>
            </div>
          </div>
          <Callout tone="success" title="Mandatory protection">
            Tenant tasks are always blocked from RFC1918, carrier-grade NAT, loopback and link-local destinations outside the managed ResourcePortal network plane. This protection cannot be disabled from the UI or API.
          </Callout>
        </Card>

        <Card className="p-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="font-semibold text-[#172033]">Enforcement state</h2>
            <StatusBadge
              tone={
                applied
                  ? "success"
                  : state.data?.enforcement?.lastError
                    ? "danger"
                    : "warning"
              }
            >
              {applied
                ? "Applied"
                : state.data?.enforcement?.lastError
                  ? "Error"
                  : "Pending"}
            </StatusBadge>
          </div>
          <DetailList
            columns={1}
            items={[
              { label: "Desired revision", value: state.data?.revision ?? "—" },
              { label: "Applied revision", value: appliedRevision ?? "—" },
              {
                label: "Last guard reconciliation",
                value: formatDate(state.data?.enforcement?.lastCompletedAt),
              },
              {
                label: "Policy updated",
                value: formatDate(state.data?.updatedAt),
              },
            ]}
          />
          {state.data?.enforcement?.lastError ? (
            <div className="mt-4">
              <Callout tone="danger" title="Egress guard reconciliation failed">
                {state.data.enforcement.lastError}
              </Callout>
            </div>
          ) : null}
        </Card>
      </div>

      <Card className="p-5">
        <h2 className="font-semibold text-[#172033]">Protected destination ranges</h2>
        <p className="mt-1 text-xs text-[#718096]">
          These destinations are denied to tenant workloads at all times.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {(state.data?.protectedCidrs ?? []).map((cidr) => (
            <code
              key={cidr}
              className="rounded-md border border-[#D7E0EC] bg-[#F5F7FA] px-2.5 py-1.5 text-xs text-[#344054]"
            >
              {cidr}
            </code>
          ))}
        </div>
      </Card>
    </main>
  );
}
