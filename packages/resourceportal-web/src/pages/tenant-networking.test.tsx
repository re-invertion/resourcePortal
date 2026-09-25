import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@xyflow/react", async () => {
  const React = await import("react");
  return {
    Background: () => null,
    Controls: () => null,
    Handle: () => null,
    MiniMap: () => null,
    Position: { Left: "left", Right: "right" },
    ReactFlow: ({
      children,
      nodes,
      edges,
      onConnect,
    }: {
      children?: React.ReactNode;
      nodes: Array<{ id: string }>;
      edges: Array<{ id: string }>;
      onConnect?: (connection: { source: string; target: string }) => void;
    }) => (
      <div data-testid="react-flow">
        <span>{nodes.length} nodes</span>
        <span>{edges.length} edges</span>
        <button
          type="button"
          onClick={() =>
            onConnect?.({
              source: "app:33333333-3333-4333-8333-333333333333",
              target: "network:22222222-2222-4222-8222-222222222222",
            })
          }
        >
          mock-connect-app
        </button>
        {children}
      </div>
    ),
    useEdgesState: (initial: unknown[]) => {
      const [value, setValue] = React.useState(initial);
      return [value, setValue, vi.fn()];
    },
    useNodesState: (initial: unknown[]) => {
      const [value, setValue] = React.useState(initial);
      return [value, setValue, vi.fn()];
    },
  };
});

import { TenantNetworkingPage } from "./tenant-networking";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const topology = {
  networks: [
    {
      id: "22222222-2222-4222-8222-222222222222",
      name: "backend",
      cidr: "10.240.10.0/24",
      overlayCidr: "10.200.10.0/24",
      status: "Ready",
      revision: 7,
      lastObservedAt: "2026-09-25T08:00:00.000Z",
      lastError: null,
      attachments: [],
      gateAttachments: [
        {
          id: "gate-link-1",
          status: "Ready",
          enabled: true,
          gate: {
            id: "44444444-4444-4444-8444-444444444444",
            name: "office",
            status: "Ready",
            lastSeenAt: "2026-09-25T08:00:00.000Z",
          },
        },
      ],
    },
  ],
  gates: [
    {
      id: "44444444-4444-4444-8444-444444444444",
      name: "office",
      status: "Ready",
      configRevision: 4,
      serverListenPort: 52000,
      clientTunnelAddress: "100.96.0.2/30",
      serverTunnelAddress: "100.96.0.1/30",
      lanAddresses: ["192.168.50.2"],
      lanCidrs: ["192.168.50.0/24"],
      lastSeenAt: "2026-09-25T08:00:00.000Z",
      networks: [
        {
          id: "gate-link-1",
          status: "Ready",
          enabled: true,
          network: {
            id: "22222222-2222-4222-8222-222222222222",
            name: "backend",
            cidr: "10.240.10.0/24",
          },
        },
      ],
    },
  ],
  appGroups: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      name: "services",
      hasPendingChanges: false,
      singleApps: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          name: "api",
          runtimeState: "Running",
          networkAttachments: [],
        },
      ],
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

it("renders topology fallback and a concrete LAN static-route plan", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(json(topology))),
  );

  render(<TenantNetworkingPage tenantId="tenant-1" />);

  expect(await screen.findByRole("heading", { name: "Networking" })).toBeTruthy();
  expect(screen.getAllByText("backend").length).toBeGreaterThan(0);
  expect(screen.getAllByText("office").length).toBeGreaterThan(0);
  expect(screen.getByText("10.240.10.0/24 via 192.168.50.2")).toBeTruthy();
  await waitFor(() =>
    expect(screen.getByTestId("react-flow").textContent).toContain("3 nodes"),
  );
  expect(screen.getByTestId("react-flow").textContent).toContain("1 edges");
});

it("turns a React Flow Application→Network connection into a durable topology Operation", async () => {
  let topologyReads = 0;
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/networking/topology")) {
      topologyReads += 1;
      return Promise.resolve(json(topology));
    }
    if (
      url.endsWith(
        "/networking/networks/22222222-2222-4222-8222-222222222222/attachments",
      ) &&
      init?.method === "POST"
    ) {
      return Promise.resolve(
        json({
          id: "55555555-5555-4555-8555-555555555555",
          status: "Pending",
        }),
      );
    }
    if (
      url.endsWith(
        "/operations/55555555-5555-4555-8555-555555555555",
      )
    ) {
      return Promise.resolve(
        json({
          id: "55555555-5555-4555-8555-555555555555",
          status: "Succeeded",
        }),
      );
    }
    return Promise.resolve(json({}));
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<TenantNetworkingPage tenantId="tenant-1" />);
  await waitFor(() =>
    expect(screen.getByTestId("react-flow").textContent).toContain("3 nodes"),
  );

  fireEvent.click(screen.getByRole("button", { name: "mock-connect-app" }));

  await waitFor(() => {
    const request = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input).endsWith(
          "/networking/networks/22222222-2222-4222-8222-222222222222/attachments",
        ) && init?.method === "POST",
    );
    expect(request).toBeTruthy();
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      singleAppId: "33333333-3333-4333-8333-333333333333",
      expectedRevision: 7,
    });
  });

  expect(
    await screen.findByText(
      /Application connected\. Deploy the affected App Group/i,
    ),
  ).toBeTruthy();
  expect(topologyReads).toBeGreaterThanOrEqual(2);
});

it("creates a Gate and shows the one-time curl installer command", async () => {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/networking/topology")) {
      return Promise.resolve(json(topology));
    }
    if (url.endsWith("/networking/gates") && init?.method === "POST") {
      return Promise.resolve(
        json({
          endpointHost: "gate.example.com",
          gate: {
            id: "66666666-6666-4666-8666-666666666666",
            name: "branch",
          },
          enrollment: {
            token: "one-time-enrollment-token",
            expiresAt: "2026-09-25T12:30:00.000Z",
          },
        }),
      );
    }
    return Promise.resolve(json({}));
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<TenantNetworkingPage tenantId="tenant-1" />);
  await waitFor(() => expect(screen.getAllByText("backend").length).toBeGreaterThan(0));

  fireEvent.click(screen.getByRole("button", { name: "Add Gate" }));
  const dialog = screen.getByRole("dialog", { name: "Add ResourcePortalGate" });
  fireEvent.change(within(dialog).getByPlaceholderText("office-gateway"), {
    target: { value: "branch" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Create Gate" }));

  const installDialog = await screen.findByRole("dialog", {
    name: "Install ResourcePortalGate",
  });
  expect(installDialog.textContent).toContain(
    "/api/networking/gates/install.sh",
  );
  expect(installDialog.textContent).toContain("one-time-enrollment-token");
  expect(installDialog.textContent).toContain("sudo bash");
});
