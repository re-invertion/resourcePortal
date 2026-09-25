import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../api/client";
import {
  Button,
  Callout,
  Card,
  ConfirmActionButton,
  DataTable,
  DetailList,
  Field,
  NetworkIcon,
  PageHeader,
  Select,
  StatusBadge,
  Toggle,
  TrashIcon,
} from "../components/design-system";
import { formatDate, text, useApi } from "../hooks/use-api";

type AppGroupOption = {
  id: string;
  name: string;
  tenantId: string;
  tenantName: string;
  networkPrivileged: boolean;
  hasPendingChanges: boolean;
  internalPortExposureCount: number;
  deployedInternalPortExposureCount: number;
};

type EgressRule = {
  id: string;
  appGroupId: string;
  appGroupName: string;
  tenantId: string;
  tenantName: string;
  destinationCidr: string;
  protocol: "any" | "tcp" | "udp";
  port: number | null;
  description?: string | null;
  createdAt?: string;
};

type ReconciliationState = {
  lastSuccessAt?: string | null;
  lastFailureAt?: string | null;
  lastCompletedAt?: string | null;
  lastResult?: { revision?: number; enabled?: boolean; rules?: number } | null;
  lastError?: string | null;
};

type EgressState = {
  enabled: boolean;
  revision: number;
  protectedCidrs: string[];
  internalNetworkCidrs: string[];
  updatedAt?: string;
  enforcement?: ReconciliationState | null;
  appGroups: AppGroupOption[];
  rules: EgressRule[];
};

export function PlatformNetworkEgressPage() {
  const state = useApi<EgressState>("/api/platform/network-egress");
  const [enabled, setEnabled] = useState(true);
  const [privilegedAppGroupId, setPrivilegedAppGroupId] = useState("");
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<{
    tone: "success" | "danger" | "warning";
    message: string;
  }>();

  useEffect(() => {
    if (!state.data) return;
    setEnabled(state.data.enabled);
    if (!privilegedAppGroupId && state.data.appGroups[0]?.id) {
      setPrivilegedAppGroupId(state.data.appGroups[0].id);
    }
  }, [state.data, privilegedAppGroupId]);

  const appliedRevision = state.data?.enforcement?.lastResult?.revision;
  const enforcementHealthy = Boolean(
    state.data?.enforcement?.lastSuccessAt &&
      (!state.data.enforcement.lastFailureAt ||
        new Date(state.data.enforcement.lastSuccessAt).getTime() >=
          new Date(state.data.enforcement.lastFailureAt).getTime()),
  );
  const applied =
    enforcementHealthy && appliedRevision === state.data?.revision;

  async function updatePolicy() {
    setWorking(true);
    setNotice(undefined);
    try {
      await apiRequest("/api/platform/network-egress", {
        method: "PATCH",
        body: { enabled },
      });
      await state.reload();
      setNotice({
        tone: enabled ? "success" : "warning",
        message: enabled
          ? "Private-network egress protection is enabled. The worker will propagate the policy to every Swarm node."
          : "Private-network egress protection is disabled. Tenant workloads can reach private networks subject to the host firewall.",
      });
    } catch (error) {
      setNotice({
        tone: "danger",
        message:
          error instanceof Error
            ? error.message
            : "Unable to update network egress policy.",
      });
    } finally {
      setWorking(false);
    }
  }

  async function updatePrivilege(privileged: boolean) {
    if (!privilegedAppGroupId) return;
    setWorking(true);
    setNotice(undefined);
    try {
      await apiRequest(
        `/api/platform/network-egress/app-groups/${encodeURIComponent(privilegedAppGroupId)}`,
        { method: "PATCH", body: { privileged } },
      );
      await state.reload();
      setNotice({
        tone: privileged ? "warning" : "success",
        message: privileged
          ? "Privileged networking enabled. This App Group can reach private networks and can configure internal TCP/UDP port exposure."
          : "Privileged networking revoked. The App Group is protected by the standard private-network egress policy again.",
      });
    } catch (error) {
      setNotice({
        tone: "danger",
        message:
          error instanceof Error
            ? error.message
            : "Unable to update App Group network privilege.",
      });
    } finally {
      setWorking(false);
    }
  }

  async function deleteRule(ruleId: string) {
    setWorking(true);
    setNotice(undefined);
    try {
      await apiRequest(`/api/platform/network-egress/rules/${encodeURIComponent(ruleId)}`, {
        method: "DELETE",
      });
      await state.reload();
      setNotice({
        tone: "success",
        message: "Private-network exception removed.",
      });
    } catch (error) {
      setNotice({
        tone: "danger",
        message:
          error instanceof Error ? error.message : "Unable to remove egress rule.",
      });
    } finally {
      setWorking(false);
    }
  }

  const selectedPrivilegedGroup = state.data?.appGroups.find(
    (appGroup) => appGroup.id === privilegedAppGroupId,
  );

  const rows = useMemo(
    () =>
      (state.data?.rules ?? []).map((rule) => ({
        key: rule.id,
        cells: {
          appGroup: (
            <div>
              <div className="font-medium text-[#172033]">{rule.appGroupName}</div>
              <div className="text-xs text-[#718096]">{rule.tenantName}</div>
            </div>
          ),
          destination: <code className="text-xs">{rule.destinationCidr}</code>,
          access:
            rule.protocol === "any"
              ? "Any protocol / port"
              : `${rule.protocol.toUpperCase()}${rule.port ? ` : ${rule.port}` : " / any port"}`,
          description: text(rule.description, "—"),
          actions: (
            <ConfirmActionButton
              size="sm"
              triggerVariant="ghost"
              confirmTitle="Remove private-network exception?"
              confirmDescription={`${rule.appGroupName} will no longer be allowed to reach ${rule.destinationCidr}${rule.port ? ` on ${rule.protocol.toUpperCase()} ${rule.port}` : ""}.`}
              confirmLabel="Remove exception"
              disabled={working}
              onConfirm={() => deleteRule(rule.id)}
              ariaLabel={`Remove egress rule for ${rule.destinationCidr}`}
            >
              <TrashIcon size={15} /> Remove
            </ConfirmActionButton>
          ),
        },
      })),
    [state.data?.rules, working],
  );

  return (
    <main>
      <PageHeader
        eyebrow="Platform Admin"
        title="Network Egress"
        description="Keep tenant workloads connected to the Internet while blocking access to private infrastructure unless the Platform Administrator grants an explicit App Group exception."
      />

      {notice ? (
        <div className="mb-5">
          <Callout tone={notice.tone} title={notice.message} />
        </div>
      ) : null}
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
                Applies on every Swarm node. Internet egress and communication inside an App Group remain available.
              </p>
            </div>
          </div>
          <Toggle
            checked={enabled}
            onChange={setEnabled}
            disabled={working || state.loading}
            label="Block private-network egress by default"
            description="Tenant tasks are blocked from RFC1918, carrier-grade NAT, loopback and link-local ranges unless an App Group rule below allows the destination."
          />
          <div className="mt-5">
            <Button
              type="button"
              variant="primary"
              disabled={working || state.loading || enabled === state.data?.enabled}
              onClick={() => void updatePolicy()}
            >
              {working ? "Applying…" : "Apply policy"}
            </Button>
          </div>
        </Card>

        <Card className="p-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="font-semibold text-[#172033]">Enforcement state</h2>
            <StatusBadge tone={applied ? "success" : state.data?.enforcement?.lastError ? "danger" : "warning"}>
              {applied ? "Applied" : state.data?.enforcement?.lastError ? "Error" : "Pending"}
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
                label: "Configured exceptions",
                value: state.data?.rules?.length ?? 0,
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

      {!state.loading && state.data?.enabled === false ? (
        <div className="mb-6">
          <Callout tone="warning" title="Private-network protection is disabled">
            Tenant containers may reach private LAN and host addresses subject only to the underlying host/network firewall.
          </Callout>
        </div>
      ) : null}

      <Card className="mb-6 p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-2xl">
            <div className="flex items-center gap-2">
              <NetworkIcon size={18} className="text-[#1769E0]" />
              <h2 className="font-semibold text-[#172033]">Legacy privileged networking cleanup</h2>
            </div>
            <p className="mt-2 text-sm leading-6 text-[#5B6678]">
              Privileged App Group networking is deprecated. Existing legacy groups remain protected during migration, but new grants are disabled. Remove and deploy all legacy Internal Port Exposures, then revoke the remaining privilege. New private connectivity belongs in tenant Networks and ResourcePortalGate.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {(state.data?.internalNetworkCidrs ?? []).map((cidr) => (
                <code key={cidr} className="rounded-md border border-[#D7E0EC] bg-[#F5F7FA] px-2.5 py-1.5 text-xs text-[#344054]">
                  Internal source: {cidr}
                </code>
              ))}
            </div>
          </div>
          <StatusBadge tone={selectedPrivilegedGroup?.networkPrivileged ? "warning" : "neutral"}>
            {selectedPrivilegedGroup?.networkPrivileged ? "Privileged" : "Standard"}
          </StatusBadge>
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-[minmax(260px,1fr)_minmax(220px,.7fr)_auto] md:items-end">
          <Field label="App Group">
            <Select
              value={privilegedAppGroupId}
              onChange={(event) => setPrivilegedAppGroupId(event.target.value)}
            >
              {(state.data?.appGroups ?? []).map((appGroup) => (
                <option key={appGroup.id} value={appGroup.id}>
                  {appGroup.tenantName} / {appGroup.name}
                </option>
              ))}
            </Select>
          </Field>
          <DetailList
            columns={1}
            items={[
              { label: "Draft internal ports", value: selectedPrivilegedGroup?.internalPortExposureCount ?? 0 },
              { label: "Deployed internal ports", value: selectedPrivilegedGroup?.deployedInternalPortExposureCount ?? 0 },
              { label: "Pending deployment changes", value: selectedPrivilegedGroup?.hasPendingChanges ? "Yes" : "No" },
            ]}
          />
          <div className="flex justify-end">
            {selectedPrivilegedGroup?.networkPrivileged ? (
              <ConfirmActionButton
                size="sm"
                triggerVariant="ghost"
                disabled={
                  working ||
                  (selectedPrivilegedGroup?.internalPortExposureCount ?? 0) > 0 ||
                  (selectedPrivilegedGroup?.deployedInternalPortExposureCount ?? 0) > 0
                }
                confirmTitle="Revoke legacy privileged networking?"
                confirmDescription="The App Group will return to the standard private-network egress policy. Remove and deploy all legacy Internal Port Exposures first."
                confirmLabel="Revoke legacy privilege"
                onConfirm={() => updatePrivilege(false)}
              >
                Revoke privilege
              </ConfirmActionButton>
            ) : (
              <StatusBadge tone="success">No legacy privilege</StatusBadge>
            )}
          </div>
        </div>
      </Card>

      <Card className="mb-6 p-5">
        <h2 className="font-semibold text-[#172033]">Protected destination ranges</h2>
        <p className="mt-1 text-xs text-[#718096]">
          These ranges are denied for tenant workloads before normal Internet egress. App Group exceptions are evaluated first.
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

      <Card className="mb-6 p-5">
        <div className="flex items-start gap-3">
          <NetworkIcon className="mt-0.5 text-[#1769E0]" />
          <div>
            <h2 className="font-semibold text-[#172033]">Legacy private-network exceptions cleanup</h2>
            <p className="mt-1 text-sm leading-6 text-[#5B6678]">
              Creating new App Group private-network egress exceptions is disabled. Existing rules remain enforced only so upgrades do not silently change traffic. Remove them after migrating the workload to the new tenant Network model.
            </p>
          </div>
        </div>
      </Card>

      <DataTable
        columns={[
          { key: "appGroup", label: "App Group" },
          { key: "destination", label: "Destination" },
          { key: "access", label: "Allowed access" },
          { key: "description", label: "Description" },
          { key: "actions", label: "" },
        ]}
        rows={rows}
        loading={state.loading}
        empty={
          <div className="px-6 py-10 text-center text-sm text-[#5B6678]">
            No private-network exceptions. Tenant workloads are limited to Internet egress and their App Group network.
          </div>
        }
      />
    </main>
  );
}
