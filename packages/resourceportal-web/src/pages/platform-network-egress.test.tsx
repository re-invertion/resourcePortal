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
    lastResult: { revision: 4, enabled: true },
    lastError: null,
  },
};

afterEach(() => vi.unstubAllGlobals());

it("shows global private-network isolation as applied without deprecated per-App-Group controls", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(json(initial))),
  );

  render(<PlatformNetworkEgressPage />);

  expect(await screen.findByText("Tenant private-network isolation")).toBeTruthy();
  expect(screen.getByText("Applied")).toBeTruthy();
  expect(screen.getByText("192.168.0.0/16")).toBeTruthy();
  expect(
    (screen.getByRole("checkbox", {
      name: /Block private-network egress by default/i,
    }) as HTMLInputElement).checked,
  ).toBe(true);
  expect(screen.queryByText(/legacy/i)).toBeNull();
  expect(screen.queryByText(/privileged/i)).toBeNull();
});

it("updates the global policy through the single supported PATCH endpoint", async () => {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/platform/network-egress" && init?.method === "PATCH") {
      return Promise.resolve(
        json({ enabled: false, revision: 5, updatedAt: "2026-09-20T17:00:00.000Z" }),
      );
    }
    return Promise.resolve(json(initial));
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<PlatformNetworkEgressPage />);
  await screen.findByText("Applied");
  const toggle = screen.getByRole("checkbox", {
    name: /Block private-network egress by default/i,
  }) as HTMLInputElement;
  await waitFor(() => expect(toggle.checked).toBe(true));
  fireEvent.click(toggle);
  expect(toggle.checked).toBe(false);
  const applyButton = screen.getByRole("button", { name: "Apply policy" }) as HTMLButtonElement;
  expect(applyButton.disabled).toBe(false);
  fireEvent.click(applyButton);

  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/platform/network-egress",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ enabled: false }),
      }),
    );
  });
});
