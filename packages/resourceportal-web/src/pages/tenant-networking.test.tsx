import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@xyflow/react", async () => {
  const React = await import("react");
  return {
    Background: () => null,
    BackgroundVariant: { Dots: "dots" },
    BaseEdge: () => null,
    Controls: () => null,
    EdgeLabelRenderer: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    Handle: () => null,
    MiniMap: () => null,
    Position: { Left: "left", Right: "right" },
    getSmoothStepPath: () => ["M0 0L10 10", 5, 5, 0, 0],
    ReactFlow: ({
      children,
      nodes,
      edges,
      onConnect,
      onNodeClick,
      onEdgeClick,
      onPaneClick,
    }: {
      children?: React.ReactNode;
      nodes: Array<{ id: string }>;
      edges: Array<{ id: string }>;
      onConnect?: (connection: { source: string; target: string }) => void;
      onNodeClick?: (event: unknown, node: { id: string }) => void;
      onEdgeClick?: (event: unknown, edge: { id: string }) => void;
      onPaneClick?: () => void;
    }) => {
      const network = nodes.find((node) => node.id.startsWith("network:"));
      const application = nodes.find((node) => node.id.startsWith("app:"));
      const gate = nodes.find((node) => node.id.startsWith("gate:"));
      const edge = edges[0];
      return (
        <div data-testid="react-flow">
          <span>{nodes.length} nodes</span>
          <span>{edges.length} edges</span>
          <span data-testid="node-ids">{nodes.map((node) => node.id).join(",")}</span>
          <span data-testid="edge-ids">{edges.map((item) => item.id).join(",")}</span>
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
          <button type="button" onClick={() => network && onNodeClick?.({}, network)}>
            mock-select-network
          </button>
          <button type="button" onClick={() => application && onNodeClick?.({}, application)}>
            mock-select-application
          </button>
          <button type="button" onClick={() => gate && onNodeClick?.({}, gate)}>
            mock-select-gate
          </button>
          <button type="button" onClick={() => edge && onEdgeClick?.({}, edge)}>
            mock-select-edge
          </button>
          <button type="button" onClick={() => onPaneClick?.()}>
            mock-select-pane
          </button>
          {children}
        </div>
      );
    },
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
import { ToastViewport } from "../components/toast";
import {
  buildTopologyGraph,
  type Topology,
  type TopologyGraphFilters,
} from "./tenant-networking-graph";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const networkId = "22222222-2222-4222-8222-222222222222";
const appGroupId = "11111111-1111-4111-8111-111111111111";
const appId = "33333333-3333-4333-8333-333333333333";
const gateId = "44444444-4444-4444-8444-444444444444";

const topology: Topology = {
  networks: [
    {
      id: networkId,
      name: "backend",
      cidr: "10.240.10.0/24",
      overlayCidr: "10.200.10.0/24",
      status: "Ready",
      revision: 7,
      lastObservedAt: "2026-09-25T08:00:00.000Z",
      lastError: null,
      attachments: [
        {
          id: "app-link-1",
          address: "10.240.10.12",
          singleAppId: appId,
          singleApp: {
            id: appId,
            name: "api",
            appGroup: {
              id: appGroupId,
              name: "services",
              hasPendingChanges: false,
            },
          },
        },
      ],
      gateAttachments: [
        {
          id: "gate-link-1",
          status: "Ready",
          enabled: true,
          gate: {
            id: gateId,
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
      id: gateId,
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
            id: networkId,
            name: "backend",
            cidr: "10.240.10.0/24",
          },
        },
      ],
    },
  ],
  appGroups: [
    {
      id: appGroupId,
      name: "services",
      hasPendingChanges: false,
      currentDeploymentVersion: 2,
      appGroupNetwork: {
        name: `rp-appgroup-${appGroupId}`,
      },
      singleApps: [
        {
          id: appId,
          name: "api",
          image: "ghcr.io/example/api:1",
          runtimeState: "Running",
          networkAttachments: [
            {
              id: "app-link-1",
              networkId,
              address: "10.240.10.12",
            },
          ],
        },
      ],
    },
  ],
};

const defaultFilters: TopologyGraphFilters = {
  query: "",
  focusNetworkId: "",
  showApplications: true,
  showGates: true,
  status: "all",
};

function unattachedTopology(): Topology {
  return {
    ...topology,
    networks: topology.networks.map((network) => ({ ...network, attachments: [] })),
    appGroups: topology.appGroups.map((group) => ({
      ...group,
      singleApps: group.singleApps.map((app) => ({ ...app, networkAttachments: [] })),
    })),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it("builds the graph only from real topology relations and contains applications inside App Group frames", () => {
  const graph = buildTopologyGraph(topology, defaultFilters);

  expect(graph.nodes.map((node) => node.id)).toEqual([
    `app-group:${appGroupId}`,
    `app:${appId}`,
    `network:${networkId}`,
    `gate:${gateId}`,
  ]);
  expect(graph.nodes.find((node) => node.id === `app:${appId}`)?.parentId).toBe(
    `app-group:${appGroupId}`,
  );
  expect(graph.edges.map((edge) => edge.id)).toEqual([
    "app-edge:app-link-1",
    `gate-edge:${gateId}:${networkId}`,
  ]);
  expect(graph.edges.some((edge) => edge.id.startsWith("app-group-edge:"))).toBe(false);
});

it("focuses one Network and removes unrelated graph clusters", () => {
  const secondNetworkId = "77777777-7777-4777-8777-777777777777";
  const secondAppId = "88888888-8888-4888-8888-888888888888";
  const secondGroupId = "99999999-9999-4999-8999-999999999999";
  const expanded: Topology = {
    ...topology,
    networks: [
      ...topology.networks,
      {
        id: secondNetworkId,
        name: "frontend",
        cidr: "10.240.20.0/24",
        overlayCidr: "10.200.20.0/24",
        status: "Ready",
        revision: 2,
        attachments: [
          {
            id: "app-link-2",
            address: "10.240.20.15",
            singleAppId: secondAppId,
            singleApp: {
              id: secondAppId,
              name: "web",
              appGroup: {
                id: secondGroupId,
                name: "frontend",
                hasPendingChanges: false,
              },
            },
          },
        ],
        gateAttachments: [],
      },
    ],
    appGroups: [
      ...topology.appGroups,
      {
        id: secondGroupId,
        name: "frontend",
        hasPendingChanges: false,
        currentDeploymentVersion: 1,
        appGroupNetwork: { name: `rp-appgroup-${secondGroupId}` },
        singleApps: [
          {
            id: secondAppId,
            name: "web",
            runtimeState: "Running",
            networkAttachments: [
              {
                id: "app-link-2",
                networkId: secondNetworkId,
                address: "10.240.20.15",
              },
            ],
          },
        ],
      },
    ],
  };

  const all = buildTopologyGraph(expanded, defaultFilters);
  const focused = buildTopologyGraph(expanded, {
    ...defaultFilters,
    focusNetworkId: networkId,
  });

  expect(all.nodes).toHaveLength(7);
  expect(all.edges).toHaveLength(3);
  expect(focused.nodes.map((node) => node.id)).toEqual([
    `app-group:${appGroupId}`,
    `app:${appId}`,
    `network:${networkId}`,
    `gate:${gateId}`,
  ]);
  expect(focused.edges).toHaveLength(2);
});

it("searches topology while preserving the connected path context", () => {
  const graph = buildTopologyGraph(topology, {
    ...defaultFilters,
    query: "api",
  });

  expect(graph.nodes.map((node) => node.id)).toEqual([
    `app-group:${appGroupId}`,
    `app:${appId}`,
    `network:${networkId}`,
    `gate:${gateId}`,
  ]);
  expect(graph.edges.map((edge) => edge.id)).toEqual([
    "app-edge:app-link-1",
    `gate-edge:${gateId}:${networkId}`,
  ]);
});

it("keeps layout stable for identical topology snapshots", () => {
  const first = buildTopologyGraph(topology, defaultFilters);
  const second = buildTopologyGraph(topology, defaultFilters);

  expect(
    second.nodes.map((node) => ({
      id: node.id,
      parentId: node.parentId,
      position: node.position,
      style: node.style,
    })),
  ).toEqual(
    first.nodes.map((node) => ({
      id: node.id,
      parentId: node.parentId,
      position: node.position,
      style: node.style,
    })),
  );
});

it("filters object types without inventing or retaining orphaned edges", () => {
  const withoutApps = buildTopologyGraph(topology, {
    ...defaultFilters,
    showApplications: false,
  });
  expect(withoutApps.nodes.map((node) => node.id)).toEqual([
    `network:${networkId}`,
    `gate:${gateId}`,
  ]);
  expect(withoutApps.edges.map((edge) => edge.id)).toEqual([
    `gate-edge:${gateId}:${networkId}`,
  ]);

  const withoutGates = buildTopologyGraph(topology, {
    ...defaultFilters,
    showGates: false,
  });
  expect(withoutGates.nodes.map((node) => node.id)).toEqual([
    `app-group:${appGroupId}`,
    `app:${appId}`,
    `network:${networkId}`,
  ]);
  expect(withoutGates.edges.map((edge) => edge.id)).toEqual(["app-edge:app-link-1"]);
});

it("shows an empty attention view when every visible resource is healthy", () => {
  const graph = buildTopologyGraph(topology, {
    ...defaultFilters,
    status: "attention",
  });
  expect(graph.nodes).toHaveLength(0);
  expect(graph.edges).toHaveLength(0);
});

it("renders the Network Control Center and a concrete LAN static-route plan", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(json(topology))),
  );

  render(<TenantNetworkingPage tenantId="tenant-1" />);

  expect(await screen.findByRole("heading", { name: "Networking" })).toBeTruthy();
  expect(screen.getByText("Network Control Center")).toBeTruthy();
  expect(screen.getAllByText("backend").length).toBeGreaterThan(0);
  expect(screen.getAllByText("office").length).toBeGreaterThan(0);
  expect(screen.getByText("10.240.10.0/24 via 192.168.50.2")).toBeTruthy();
  await waitFor(() =>
    expect(screen.getByTestId("react-flow").textContent).toContain("4 nodes"),
  );
  expect(screen.getByTestId("react-flow").textContent).toContain("2 edges");
  expect(screen.getByTestId("edge-ids").textContent).toContain("app-edge:app-link-1");
  expect(screen.getByTestId("edge-ids").textContent).not.toContain("app-group-edge");
});

it("shows a Network inspector and can enter focused mode", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(json(topology))),
  );

  render(<TenantNetworkingPage tenantId="tenant-1" />);
  await waitFor(() =>
    expect(screen.getByTestId("react-flow").textContent).toContain("4 nodes"),
  );

  fireEvent.click(screen.getByRole("button", { name: "mock-select-network" }));

  expect(await screen.findByText("Focus this Network")).toBeTruthy();
  expect(screen.getByText("10.200.10.0/24")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Focus this Network" }));
  expect(await screen.findByText("Show all networks")).toBeTruthy();
  expect(screen.getByText("Focused")).toBeTruthy();
});

it("turns a React Flow Application→Network connection into a durable topology Operation", async () => {
  let topologyReads = 0;
  const disconnected = unattachedTopology();
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/networking/topology")) {
      topologyReads += 1;
      return Promise.resolve(json(disconnected));
    }
    if (
      url.endsWith(
        `/networking/networks/${networkId}/attachments`,
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

  render(<><TenantNetworkingPage tenantId="tenant-1" /><ToastViewport /></>);
  await waitFor(() =>
    expect(screen.getByTestId("react-flow").textContent).toContain("4 nodes"),
  );

  fireEvent.click(screen.getByRole("button", { name: "mock-connect-app" }));

  await waitFor(() => {
    const request = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input).endsWith(
          `/networking/networks/${networkId}/attachments`,
        ) && init?.method === "POST",
    );
    expect(request).toBeTruthy();
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      singleAppId: appId,
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

it("disconnects a real graph edge from the inspector", async () => {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/networking/topology")) {
      return Promise.resolve(json(topology));
    }
    if (
      url.includes(
        `/networking/networks/${networkId}/attachments/app-link-1?revision=7`,
      ) &&
      init?.method === "DELETE"
    ) {
      return Promise.resolve(
        json({
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          status: "Pending",
        }),
      );
    }
    if (url.endsWith("/operations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")) {
      return Promise.resolve(
        json({
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          status: "Succeeded",
        }),
      );
    }
    return Promise.resolve(json({}));
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<TenantNetworkingPage tenantId="tenant-1" />);
  await waitFor(() =>
    expect(screen.getByTestId("react-flow").textContent).toContain("2 edges"),
  );

  fireEvent.click(screen.getByRole("button", { name: "mock-select-edge" }));
  expect(await screen.findByText("Application → Network")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Delete connection" }));

  const dialog = await screen.findByRole("dialog", {
    name: "Delete network connection?",
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete connection" }));

  await waitFor(() => {
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input).includes(
            `/networking/networks/${networkId}/attachments/app-link-1?revision=7`,
          ) && init?.method === "DELETE",
      ),
    ).toBe(true);
  });
});

it("deletes a VPN Gate from the graph inspector after confirmation", async () => {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/networking/topology")) {
      return Promise.resolve(json(topology));
    }
    if (url.endsWith(`/networking/gates/${gateId}`) && init?.method === "DELETE") {
      return Promise.resolve(json({ id: gateId, revokedAt: "2026-09-26T08:00:00.000Z" }));
    }
    return Promise.resolve(json({}));
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<TenantNetworkingPage tenantId="tenant-1" />);
  await waitFor(() =>
    expect(screen.getByTestId("react-flow").textContent).toContain("4 nodes"),
  );

  fireEvent.click(screen.getByRole("button", { name: "mock-select-gate" }));
  fireEvent.click(await screen.findByRole("button", { name: "Delete VPN" }));

  const dialog = await screen.findByRole("dialog", { name: "Delete VPN?" });
  expect(dialog.textContent).toContain("WireGuard/VPN");
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete VPN" }));

  await waitFor(() => {
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input).endsWith(`/networking/gates/${gateId}`) &&
          init?.method === "DELETE",
      ),
    ).toBe(true);
  });
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
