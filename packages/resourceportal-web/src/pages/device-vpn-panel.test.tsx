import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DeviceVpnPanel } from "./device-vpn-panel";
import type { NetworkResource } from "./tenant-networking-graph";

const network: NetworkResource = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "backend",
  cidr: "10.240.10.0/24",
  overlayCidr: "10.200.10.0/24",
  status: "Ready",
  revision: 1,
  attachments: [],
  gateAttachments: [],
};

const networkTwo: NetworkResource = {
  id: "55555555-5555-4555-8555-555555555555",
  name: "monitoring",
  cidr: "10.240.20.0/24",
  overlayCidr: "10.200.20.0/24",
  status: "Ready",
  revision: 1,
  attachments: [],
  gateAttachments: [],
};

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

it("creates a Device VPN and shows one-time WireGuard config with scoped AllowedIPs", async () => {
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/networking/device-vpn/devices") && (!init?.method || init.method === "GET")) {
        return json([]);
      }
      if (
        url.endsWith("/networking/device-vpn/devices") &&
        init?.method === "POST"
      ) {
        return json({
          device: {
            id: "33333333-3333-4333-8333-333333333333",
            name: "work-laptop",
            assignedAddress: "100.64.0.2",
            address: "100.64.0.2/32",
            status: "Pending",
            networks: [
              {
                id: network.id,
                name: network.name,
                cidr: network.cidr,
              },
            ],
          },
          configuration: {
            endpoint: "vpn.example.test:51820",
            serverPublicKey:
              "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
            address: "100.64.0.2/32",
            allowedIps: [network.cidr],
            persistentKeepaliveSeconds: 25,
            privateKey:
              "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            privateKeyStored: false,
            wireguardConfig:
              "[Interface]\nPrivateKey = AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\nAddress = 100.64.0.2/32\n\n[Peer]\nPublicKey = BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=\nEndpoint = vpn.example.test:51820\nAllowedIPs = 10.240.10.0/24\nPersistentKeepalive = 25\n",
          },
        });
      }
      return json([]);
    });

  render(
    <DeviceVpnPanel
      tenantId="11111111-1111-4111-8111-111111111111"
      networks={[network]}
    />,
  );

  await screen.findByText("No Device VPN devices");
  fireEvent.click(screen.getByRole("button", { name: "Add Device VPN" }));
  fireEvent.change(screen.getByPlaceholderText("work-laptop"), {
    target: { value: "work-laptop" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create Device VPN" }));

  expect(await screen.findByText("Private key is shown only now")).toBeTruthy();
  expect(screen.getByText(/AllowedIPs = 10\.240\.10\.0\/24/)).toBeTruthy();
  expect(screen.getByText("vpn.example.test:51820")).toBeTruthy();
  expect(
    fetchMock.mock.calls.some(
      ([input, init]) =>
        String(input).endsWith("/networking/device-vpn/devices") &&
        init?.method === "POST" &&
        JSON.stringify(init.body).includes(network.id),
    ),
  ).toBe(true);
});

it("updates Device VPN Network access and exposes the new AllowedIPs list", async () => {
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = String(input);
      if (
        url.endsWith("/networking/device-vpn/devices") &&
        (!init?.method || init.method === "GET")
      ) {
        return json([
          {
            id: "33333333-3333-4333-8333-333333333333",
            name: "work-laptop",
            assignedAddress: "100.64.0.2",
            address: "100.64.0.2/32",
            status: "Ready",
            networks: [
              { id: network.id, name: network.name, cidr: network.cidr },
            ],
          },
        ]);
      }
      if (init?.method === "PATCH") {
        return json({
          id: "33333333-3333-4333-8333-333333333333",
          name: "work-laptop",
          assignedAddress: "100.64.0.2",
          address: "100.64.0.2/32",
          status: "Pending",
          networks: [
            { id: network.id, name: network.name, cidr: network.cidr },
            {
              id: networkTwo.id,
              name: networkTwo.name,
              cidr: networkTwo.cidr,
            },
          ],
        });
      }
      return json([]);
    });

  render(
    <DeviceVpnPanel
      tenantId="11111111-1111-4111-8111-111111111111"
      networks={[network, networkTwo]}
    />,
  );

  await screen.findByText("work-laptop");
  fireEvent.click(screen.getByRole("button", { name: "Edit access" }));

  expect(await screen.findByText("Update the client AllowedIPs too")).toBeTruthy();
  const monitoring = screen.getByText("monitoring").closest("label");
  if (!monitoring) throw new Error("Missing monitoring Network option");
  fireEvent.click(monitoring.querySelector("input")!);

  expect(
    screen.getByText("10.240.10.0/24, 10.240.20.0/24"),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Save access" }));

  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input).includes(
            "/device-vpn/devices/33333333-3333-4333-8333-333333333333",
          ) &&
          init?.method === "PATCH" &&
          JSON.stringify(init.body).includes(networkTwo.id),
      ),
    ).toBe(true),
  );
});

it("revokes an existing Device VPN", async () => {
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/networking/device-vpn/devices") && (!init?.method || init.method === "GET")) {
        return json([
          {
            id: "33333333-3333-4333-8333-333333333333",
            name: "work-laptop",
            assignedAddress: "100.64.0.2",
            address: "100.64.0.2/32",
            status: "Ready",
            lastSeenAt: "2026-10-07T10:00:00.000Z",
            networks: [{ id: network.id, name: network.name, cidr: network.cidr }],
          },
        ]);
      }
      if (init?.method === "DELETE") {
        return json({ status: "Revoked" });
      }
      return json([]);
    });

  render(
    <DeviceVpnPanel
      tenantId="11111111-1111-4111-8111-111111111111"
      networks={[network]}
    />,
  );

  await screen.findByText("work-laptop");
  fireEvent.click(
    screen.getByRole("button", { name: "Revoke Device VPN work-laptop" }),
  );
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(
    withinDialogButton(dialog, "Revoke Device VPN"),
  );

  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input).includes(
            "/device-vpn/devices/33333333-3333-4333-8333-333333333333",
          ) && init?.method === "DELETE",
      ),
    ).toBe(true),
  );
});

function withinDialogButton(dialog: HTMLElement, name: string) {
  const button = Array.from(dialog.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!button) throw new Error(`Missing dialog button ${name}`);
  return button;
}
