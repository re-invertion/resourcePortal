import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("./tenant-networking-graph", () => ({
  TenantNetworkingGraph: () => <div data-testid="networking-graph" />,
}));

import { TenantNetworkingPage } from "./tenant-networking";

const gateId = "44444444-4444-4444-8444-444444444444";

const topology = {
  networks: [],
  appGroups: [],
  gates: [
    {
      id: gateId,
      name: "office",
      description: "Office LAN",
      status: "Ready",
      configRevision: 7,
      serverListenPort: 52000,
      clientTunnelAddress: "100.96.0.2/30",
      serverTunnelAddress: "100.96.0.1/30",
      lanAddresses: ["192.168.50.2"],
      lanCidrs: ["192.168.50.0/24"],
      agentVersion: "gate-shell-v2",
      routeAdvertisementMode: "Manual",
      bgpLocalAsn: null,
      bgpRouterAddress: null,
      bgpRouterAsn: null,
      bgpSourceAddress: null,
      bgpHoldTimeSeconds: 90,
      advertisedCidrs: [],
      lastSeenAt: "2026-09-30T08:00:00.000Z",
      lastError: null,
      revokedAt: null,
      networks: [
        {
          id: "gate-link-1",
          status: "Ready",
          enabled: true,
          lastError: null,
          network: {
            id: "22222222-2222-4222-8222-222222222222",
            name: "backend",
            cidr: "10.240.10.0/24",
          },
        },
      ],
    },
  ],
};

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it("configures export-only BGP route advertisement using Gate-attached prefixes", async () => {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/networking/topology")) {
      return Promise.resolve(json(topology));
    }
    if (
      url.endsWith(`/networking/gates/${gateId}/routing`) &&
      init?.method === "PATCH"
    ) {
      return Promise.resolve(
        json({
          ...topology.gates[0],
          routeAdvertisementMode: "BGP",
          bgpLocalAsn: 65050,
          bgpRouterAddress: "192.168.50.1",
          bgpRouterAsn: 65001,
          bgpSourceAddress: "192.168.50.2",
          advertisedCidrs: ["10.240.10.0/24"],
        }),
      );
    }
    return Promise.resolve(json({}));
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<TenantNetworkingPage tenantId="tenant-1" />);

  await waitFor(() => {
    expect(screen.getAllByText("office").length).toBeGreaterThan(0);
  });

  fireEvent.click(screen.getByRole("button", { name: "Routing" }));
  const dialog = screen.getByRole("dialog", {
    name: "Route advertisement · office",
  });

  fireEvent.change(within(dialog).getByRole("combobox"), {
    target: { value: "BGP" },
  });

  expect(dialog.textContent).toContain("Export-only eBGP");
  expect(dialog.textContent).toContain("10.240.10.0/24");

  fireEvent.change(within(dialog).getByPlaceholderText("65050"), {
    target: { value: "65050" },
  });
  fireEvent.change(within(dialog).getByPlaceholderText("65001"), {
    target: { value: "65001" },
  });
  fireEvent.change(within(dialog).getByPlaceholderText("192.168.1.1"), {
    target: { value: "192.168.50.1" },
  });

  fireEvent.click(within(dialog).getByRole("button", { name: "Save routing" }));

  await waitFor(() => {
    const request = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input).endsWith(`/networking/gates/${gateId}/routing`) &&
        init?.method === "PATCH",
    );
    expect(request).toBeTruthy();
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      mode: "BGP",
      localAsn: 65050,
      routerAddress: "192.168.50.1",
      routerAsn: 65001,
      sourceAddress: "192.168.50.2",
      holdTimeSeconds: 90,
    });
  });
});
