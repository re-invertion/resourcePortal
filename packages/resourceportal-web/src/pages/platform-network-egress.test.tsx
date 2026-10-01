import { render, screen } from "@testing-library/react";
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
    lastResult: { revision: 4, enabled: true },
    lastError: null,
  },
};

afterEach(() => vi.unstubAllGlobals());

it("shows mandatory private-network isolation without any disable control", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(json(initial))),
  );

  render(<PlatformNetworkEgressPage />);

  expect(await screen.findByText("Tenant private-network isolation")).toBeTruthy();
  expect(screen.getByText("Applied")).toBeTruthy();
  expect(screen.getByText("192.168.0.0/16")).toBeTruthy();
  expect(screen.getByText("Mandatory protection")).toBeTruthy();
  expect(screen.getByText(/cannot be disabled from the UI or API/i)).toBeTruthy();
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.queryByRole("button", { name: "Apply policy" })).toBeNull();
  expect(screen.queryByText(/legacy/i)).toBeNull();
  expect(screen.queryByText(/privileged/i)).toBeNull();
});
