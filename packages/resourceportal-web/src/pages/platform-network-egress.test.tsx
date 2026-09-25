import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PlatformNetworkEgressPage } from "./platform-network-egress";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const initial = {
  enabled: true,
  revision: 4,
  protectedCidrs: ["10.0.0.0/8", "192.168.0.0/16", "169.254.0.0/16"],
  internalNetworkCidrs: ["192.168.100.0/24"],
  updatedAt: "2026-09-20T16:00:00.000Z",
  enforcement: {
    lastSuccessAt: "2026-09-20T16:00:01.000Z",
    lastFailureAt: null,
    lastCompletedAt: "2026-09-20T16:00:01.000Z",
    lastResult: { revision: 4, enabled: true, rules: 0 },
    lastError: null,
  },
  appGroups: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      name: "penpot",
      tenantId: "22222222-2222-4222-8222-222222222222",
      tenantName: "Design",
      networkPrivileged: false,
      hasPendingChanges: false,
      internalPortExposureCount: 0,
      deployedInternalPortExposureCount: 0,
    },
  ],
  rules: [],
};

afterEach(() => vi.unstubAllGlobals());

it("shows default private-network isolation as applied", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(json(initial))),
  );

  render(<PlatformNetworkEgressPage />);

  expect(await screen.findByText("Tenant private-network isolation")).toBeTruthy();
  expect(screen.getByText("Applied")).toBeTruthy();
  expect(screen.getByText("192.168.0.0/16")).toBeTruthy();
  expect(screen.getByText(/No private-network exceptions/i)).toBeTruthy();
  expect(
    (screen.getByRole("checkbox", {
      name: /Block private-network egress by default/i,
    }) as HTMLInputElement).checked,
  ).toBe(true);
});

it("shows existing private-network exceptions as cleanup-only and allows deletion", async () => {
  const legacy = {
    ...initial,
    enforcement: {
      ...initial.enforcement,
      lastResult: { revision: 4, enabled: true, rules: 1 },
    },
    rules: [
      {
        id: "rule-1",
        appGroupId: initial.appGroups[0].id,
        appGroupName: "penpot",
        tenantId: initial.appGroups[0].tenantId,
        tenantName: "Design",
        destinationCidr: "192.168.100.50/32",
        protocol: "tcp",
        port: 443,
        description: "Legacy monitoring",
      },
    ],
  };
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/platform/network-egress/rules/rule-1" && init?.method === "DELETE") {
      return Promise.resolve(json({ deleted: true }));
    }
    if (url === "/api/platform/network-egress") {
      return Promise.resolve(json(legacy));
    }
    return Promise.resolve(json({}));
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<PlatformNetworkEgressPage />);
  expect(await screen.findByText("Legacy private-network exceptions cleanup")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Add exception" })).toBeNull();
  expect(screen.getByText("192.168.100.50/32")).toBeTruthy();

  fireEvent.click(
    screen.getByRole("button", {
      name: "Remove egress rule for 192.168.100.50/32",
    }),
  );
  const confirm = await screen.findByRole("dialog");
  fireEvent.click(
    within(confirm).getByRole("button", { name: "Remove exception" }),
  );

  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/platform/network-egress/rules/rule-1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});

it("shows legacy privileged networking as cleanup-only and does not offer new grants", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(json(initial))),
  );

  render(<PlatformNetworkEgressPage />);
  expect(
    await screen.findByText("Legacy privileged networking cleanup"),
  ).toBeTruthy();
  expect(screen.getByText("Internal source: 192.168.100.0/24")).toBeTruthy();
  expect(screen.getByText("No legacy privilege")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Grant privilege/i })).toBeNull();
});
