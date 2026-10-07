import { useMemo, useState, type FormEvent } from "react";
import { QRCodeSVG } from "qrcode.react";
import { apiRequest } from "../api/client";
import {
  Button,
  Callout,
  Card,
  Checkbox,
  ConfirmActionButton,
  CopyIcon,
  Dialog,
  EmptyState,
  Field,
  PlusIcon,
  StatusBadge,
  TextInput,
  TrashIcon,
  statusTone,
} from "../components/design-system";
import { toast } from "../components/toast";
import { formatDate, useApi } from "../hooks/use-api";
import type { NetworkResource } from "./tenant-networking-graph";

type DeviceVpnNetwork = {
  id: string;
  name: string;
  cidr: string;
};

type DeviceVpnDevice = {
  id: string;
  name: string;
  assignedAddress: string;
  address?: string;
  status: string;
  networks: DeviceVpnNetwork[];
  lastSeenAt?: string | null;
  lastError?: string | null;
};

type DeviceVpnConfiguration = {
  endpoint: string;
  serverPublicKey: string;
  address: string;
  allowedIps: string[];
  persistentKeepaliveSeconds: number;
  privateKey: string;
  wireguardConfig: string;
  privateKeyStored: false;
};

type DeviceVpnProvisioning = {
  device: DeviceVpnDevice;
  configuration: DeviceVpnConfiguration;
};

function downloadConfig(name: string, configuration: string) {
  const blob = new Blob([configuration], {
    type: "text/plain;charset=utf-8",
  });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = `${name.replace(/[^a-zA-Z0-9._-]+/g, "-") || "resourceportal"}.conf`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(href);
}

export function DeviceVpnPanel({
  tenantId,
  networks,
}: {
  tenantId: string;
  networks: NetworkResource[];
}) {
  const root = `/api/tenants/${encodeURIComponent(tenantId)}/networking/device-vpn/devices`;
  const devices = useApi<DeviceVpnDevice[]>(root);
  const [createOpen, setCreateOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [name, setName] = useState("");
  const [selectedNetworks, setSelectedNetworks] = useState<string[]>([]);
  const [provisioning, setProvisioning] = useState<DeviceVpnProvisioning>();
  const [editDevice, setEditDevice] = useState<DeviceVpnDevice>();
  const [editNetworks, setEditNetworks] = useState<string[]>([]);

  const selectableNetworks = useMemo(
    () => networks.filter((network) => network.status !== "Deleting"),
    [networks],
  );

  function beginCreate() {
    setName("");
    setSelectedNetworks(selectableNetworks.map((network) => network.id));
    setProvisioning(undefined);
    setCreateOpen(true);
  }

  function toggleNetwork(networkId: string, checked: boolean) {
    setSelectedNetworks((current) =>
      checked
        ? [...new Set([...current, networkId])]
        : current.filter((id) => id !== networkId),
    );
  }

  async function createDevice(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || selectedNetworks.length === 0) return;
    setWorking(true);
    try {
      const response = await apiRequest<DeviceVpnProvisioning>(root, {
        method: "POST",
        body: {
          name: name.trim(),
          networkIds: selectedNetworks,
        },
      });
      setProvisioning(response);
      await devices.reload();
      toast.success("Device VPN created.");
    } catch (error) {
      toast.errorFrom(error, "Unable to create Device VPN.");
    } finally {
      setWorking(false);
    }
  }

  function beginEdit(device: DeviceVpnDevice) {
    setEditDevice(device);
    setEditNetworks(device.networks.map((network) => network.id));
  }

  async function updateDeviceAccess(event: FormEvent) {
    event.preventDefault();
    if (!editDevice || editNetworks.length === 0) return;
    setWorking(true);
    try {
      await apiRequest(`${root}/${encodeURIComponent(editDevice.id)}`, {
        method: "PATCH",
        body: { networkIds: editNetworks },
      });
      await devices.reload();
      toast.success(`Device VPN ${editDevice.name} access updated.`);
      setEditDevice(undefined);
      setEditNetworks([]);
    } catch (error) {
      toast.errorFrom(error, "Unable to update Device VPN access.");
    } finally {
      setWorking(false);
    }
  }

  async function revokeDevice(device: DeviceVpnDevice) {
    setWorking(true);
    try {
      await apiRequest(`${root}/${encodeURIComponent(device.id)}`, {
        method: "DELETE",
      });
      await devices.reload();
      toast.success(`Device VPN ${device.name} revoked.`);
    } catch (error) {
      toast.errorFrom(error, "Unable to revoke Device VPN.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <>
      <Card className="mt-6 overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#E1E7F0] px-5 py-4">
          <div>
            <h2 className="font-semibold text-[#172033]">Device VPN</h2>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-[#718096]">
              Connect an individual laptop, workstation or phone directly to
              selected ResourcePortal Networks over WireGuard. Device VPN does
              not route general Internet traffic or grant implicit access to a
              Site VPN LAN.
            </p>
          </div>
          <Button
            size="sm"
            variant="primary"
            disabled={selectableNetworks.length === 0}
            onClick={beginCreate}
          >
            <PlusIcon size={14} /> Add Device VPN
          </Button>
        </div>

        {devices.error ? (
          <div className="p-5">
            <Callout tone="danger" title="Device VPN unavailable">
              {devices.error instanceof Error
                ? devices.error.message
                : "Device VPN devices could not be loaded."}
            </Callout>
          </div>
        ) : devices.loading ? (
          <p className="p-5 text-sm text-[#718096]">
            Loading Device VPN devices…
          </p>
        ) : devices.data?.length ? (
          <div className="divide-y divide-[#E1E7F0]">
            {devices.data.map((device) => (
              <div
                key={device.id}
                className="flex flex-wrap items-center gap-4 px-5 py-4"
              >
                <div className="min-w-[180px] flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong className="text-[13px] text-[#172033]">
                      {device.name}
                    </strong>
                    <StatusBadge tone={statusTone(device.status)}>
                      {device.status}
                    </StatusBadge>
                  </div>
                  <code className="mt-1 block text-[11px] text-[#718096]">
                    {device.address ?? `${device.assignedAddress}/32`}
                  </code>
                  <span className="mt-1 block text-[11px] text-[#718096]">
                    Last WireGuard handshake: {formatDate(device.lastSeenAt)}
                  </span>
                  {device.lastError ? (
                    <span className="mt-1 block text-[11px] text-[#B42318]">
                      {device.lastError}
                    </span>
                  ) : null}
                </div>
                <div className="min-w-[220px] flex-[1.2] text-xs text-[#5B6678]">
                  <strong className="mb-1 block text-[11px] uppercase tracking-wide text-[#718096]">
                    Allowed Networks
                  </strong>
                  {device.networks.length
                    ? device.networks
                        .map((network) => `${network.name} (${network.cidr})`)
                        .join(", ")
                    : "No Networks"}
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={working}
                  onClick={() => beginEdit(device)}
                >
                  Edit access
                </Button>
                <ConfirmActionButton
                  size="sm"
                  triggerVariant="ghost"
                  disabled={working}
                  ariaLabel={`Revoke Device VPN ${device.name}`}
                  confirmTitle={`Revoke ${device.name}?`}
                  confirmDescription="The WireGuard peer is removed from the shared Device VPN concentrator. Reconnecting with the old configuration will no longer work."
                  confirmLabel="Revoke Device VPN"
                  onConfirm={() => revokeDevice(device)}
                >
                  <TrashIcon size={14} /> Revoke
                </ConfirmActionButton>
              </div>
            ))}
          </div>
        ) : (
          <div className="p-5">
            <EmptyState
              title="No Device VPN devices"
              description="Add a device to connect it directly to selected tenant Networks without installing a Site VPN gateway in its local network."
            />
          </div>
        )}
      </Card>

      <Dialog
        open={createOpen}
        onClose={() => {
          if (!working) {
            setCreateOpen(false);
            setProvisioning(undefined);
          }
        }}
        title={provisioning ? "Device VPN configuration" : "Add Device VPN"}
        description={
          provisioning
            ? "Import this one-time configuration into a WireGuard client."
            : "Create a per-device WireGuard peer and choose exactly which ResourcePortal Networks it may reach."
        }
        actions={
          provisioning ? (
            <Button
              variant="primary"
              onClick={() => {
                setCreateOpen(false);
                setProvisioning(undefined);
              }}
            >
              Done
            </Button>
          ) : (
            <>
              <Button disabled={working} onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                type="submit"
                form="device-vpn-create-form"
                disabled={
                  working || !name.trim() || selectedNetworks.length === 0
                }
              >
                {working ? "Creating…" : "Create Device VPN"}
              </Button>
            </>
          )
        }
      >
        {provisioning ? (
          <div className="space-y-4">
            <Callout tone="warning" title="Private key is shown only now">
              ResourcePortal stores only the device public key. Save or import
              this configuration now. If it is lost, revoke the device and
              create a new Device VPN.
            </Callout>
            <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
              <div className="flex items-center justify-center rounded-lg border border-[#D7E0EC] bg-white p-4">
                <QRCodeSVG
                  value={provisioning.configuration.wireguardConfig}
                  size={190}
                  level="M"
                  title="WireGuard Device VPN configuration"
                />
              </div>
              <div className="min-w-0 rounded-lg border border-[#D7E0EC] bg-[#0F1724] p-4 text-white">
                <pre className="m-0 max-h-[360px] overflow-auto whitespace-pre-wrap break-all bg-transparent p-0 text-xs leading-5 text-white">
                  <code>{provisioning.configuration.wireguardConfig}</code>
                </pre>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() =>
                  void navigator.clipboard.writeText(
                    provisioning.configuration.wireguardConfig,
                  )
                }
              >
                <CopyIcon size={14} /> Copy config
              </Button>
              <Button
                size="sm"
                onClick={() =>
                  downloadConfig(
                    provisioning.device.name,
                    provisioning.configuration.wireguardConfig,
                  )
                }
              >
                Download .conf
              </Button>
            </div>
            <p className="text-xs leading-5 text-[#5B6678]">
              Endpoint:{" "}
              <code>{provisioning.configuration.endpoint}</code>. AllowedIPs
              contains only the Networks selected for this device.
            </p>
          </div>
        ) : (
          <form
            id="device-vpn-create-form"
            className="space-y-4"
            onSubmit={(event) => void createDevice(event)}
          >
            <Field
              label="Device name"
              required
              hint="For example: Patryk MacBook, Workstation or iPhone."
            >
              <TextInput
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="work-laptop"
              />
            </Field>
            <Field
              label="Allowed Networks"
              required
              hint="The WireGuard client receives routes only for these ResourcePortal Networks."
            >
              <div className="space-y-2 rounded-lg border border-[#D7E0EC] p-3">
                {selectableNetworks.map((network) => (
                  <label
                    key={network.id}
                    className="flex cursor-pointer items-start gap-3 rounded-md px-2 py-2 hover:bg-[#F8FAFD]"
                  >
                    <Checkbox
                      checked={selectedNetworks.includes(network.id)}
                      onChange={(event) =>
                        toggleNetwork(network.id, event.target.checked)
                      }
                    />
                    <span className="min-w-0">
                      <strong className="block text-[13px] text-[#172033]">
                        {network.name}
                      </strong>
                      <code className="text-[11px] text-[#718096]">
                        {network.cidr}
                      </code>
                    </span>
                  </label>
                ))}
                {selectableNetworks.length === 0 ? (
                  <p className="text-xs text-[#718096]">
                    Create a tenant Network before adding Device VPN access.
                  </p>
                ) : null}
              </div>
            </Field>
          </form>
        )}
      </Dialog>

      <Dialog
        open={Boolean(editDevice)}
        onClose={() => {
          if (!working) {
            setEditDevice(undefined);
            setEditNetworks([]);
          }
        }}
        title={editDevice ? `Edit Device VPN access: ${editDevice.name}` : "Edit Device VPN access"}
        description="Server-side access changes immediately after reconciliation. If you add or remove Networks, update AllowedIPs in the local WireGuard client to match the CIDRs shown here."
        actions={
          <>
            <Button
              disabled={working}
              onClick={() => {
                setEditDevice(undefined);
                setEditNetworks([]);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              form="device-vpn-edit-form"
              disabled={working || editNetworks.length === 0}
            >
              {working ? "Saving…" : "Save access"}
            </Button>
          </>
        }
      >
        <form
          id="device-vpn-edit-form"
          className="space-y-4"
          onSubmit={(event) => void updateDeviceAccess(event)}
        >
          <Callout tone="warning" title="Update the client AllowedIPs too">
            ResourcePortal does not store this device&apos;s private key, so it
            cannot regenerate the original configuration. After saving, make
            sure the WireGuard client AllowedIPs exactly matches the CIDRs you
            leave selected below.
          </Callout>
          <Field
            label="Allowed Networks"
            required
            hint="At least one ResourcePortal Network must remain assigned."
          >
            <div className="space-y-2 rounded-lg border border-[#D7E0EC] p-3">
              {selectableNetworks.map((network) => (
                <label
                  key={network.id}
                  className="flex cursor-pointer items-start gap-3 rounded-md px-2 py-2 hover:bg-[#F8FAFD]"
                >
                  <Checkbox
                    checked={editNetworks.includes(network.id)}
                    onChange={(event) =>
                      setEditNetworks((current) =>
                        event.target.checked
                          ? [...new Set([...current, network.id])]
                          : current.filter((id) => id !== network.id),
                      )
                    }
                  />
                  <span className="min-w-0">
                    <strong className="block text-[13px] text-[#172033]">
                      {network.name}
                    </strong>
                    <code className="text-[11px] text-[#718096]">
                      {network.cidr}
                    </code>
                  </span>
                </label>
              ))}
            </div>
          </Field>
          <div className="rounded-lg bg-[#F8FAFD] p-3 text-xs leading-5 text-[#5B6678]">
            AllowedIPs:{" "}
            <code>
              {selectableNetworks
                .filter((network) => editNetworks.includes(network.id))
                .map((network) => network.cidr)
                .join(", ") || "none"}
            </code>
          </div>
        </form>
      </Dialog>
    </>
  );
}
