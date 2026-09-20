import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

it("creates an App Group-scoped TCP exception without redeploying the application", async () => {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (
      url === "/api/platform/network-egress/rules" &&
      init?.method === "POST"
    ) {
      return Promise.resolve(
        json({
          id: "rule-1",
          appGroupId: initial.appGroups[0].id,
          destinationCidr: "192.168.100.50/32",
          protocol: "tcp",
          port: 443,
        }),
      );
    }
    if (url === "/api/platform/network-egress") {
      return Promise.resolve(json(initial));
    }
    return Promise.resolve(json({}));
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<PlatformNetworkEgressPage />);
  await screen.findByText("Tenant private-network isolation");

  fireEvent.change(screen.getByLabelText(/Destination IP \/ CIDR/i), {
    target: { value: "192.168.100.50/32" },
  });
  fireEvent.change(screen.getByLabelText("Protocol"), {
    target: { value: "tcp" },
  });
  fireEvent.change(screen.getByLabelText(/Port/i), {
    target: { value: "443" },
  });
  fireEvent.change(screen.getByLabelText("Description"), {
    target: { value: "Monitoring API" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add exception" }));

  await waitFor(() => {
    const request = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url) === "/api/platform/network-egress/rules" &&
        init?.method === "POST",
    );
    expect(request).toBeTruthy();
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      appGroupId: "11111111-1111-4111-8111-111111111111",
      destinationCidr: "192.168.100.50/32",
      protocol: "tcp",
      port: 443,
      description: "Monitoring API",
    });
  });
});
