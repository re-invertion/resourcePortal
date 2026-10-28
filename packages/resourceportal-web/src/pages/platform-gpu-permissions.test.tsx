import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PlatformPage } from "./platform";

const tenantId = "12345678-1234-4234-8234-123456789abc";
const json = (data: unknown) => new Response(JSON.stringify(data), {
  status: 200, headers: { "content-type": "application/json" },
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("allows Platform Admin to grant GPU quota without entering tenant-private workspaces", async () => {
  const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/platform/tenants") return Promise.resolve(json([
      { id: tenantId, name: "Research", quota: { gpu: 0 } },
    ]));
    if (path === "/api/platform/gpu-devices") return Promise.resolve(json([]));
    if (path === "/api/platform/tenants/" + tenantId + "/quota" && init?.method === "PATCH") {
      return Promise.resolve(json({ gpu: 1 }));
    }
    return Promise.resolve(json([]));
  });
  vi.stubGlobal("fetch", fetcher);
  render(<PlatformPage section="infrastructure" />);
  expect(await screen.findByRole("heading", { name: "Tenant GPU permissions" })).toBeTruthy();
  await screen.findByRole("option", { name: "Research" });
  fireEvent.change(screen.getByLabelText("GPU quota tenant"), { target: { value: tenantId } });
  fireEvent.change(screen.getByLabelText("GPU quota limit"), { target: { value: "1" } });
  fireEvent.click(screen.getByRole("button", { name: "Save GPU quota" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
    "/api/platform/tenants/" + tenantId + "/quota",
    expect.objectContaining({ method: "PATCH", body: JSON.stringify({ gpu: 1 }) }),
  ));
  expect(fetcher.mock.calls.some(([input]) => String(input).startsWith("/api/tenants/"))).toBe(false);
});

it("requires an explicit complete base quota before granting GPUs to a new tenant", async () => {
  const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/platform/tenants") return Promise.resolve(json([
      { id: tenantId, name: "New tenant", quota: null },
    ]));
    if (path === "/api/platform/gpu-devices") return Promise.resolve(json([]));
    if (path === "/api/platform/tenants/" + tenantId + "/quota" && init?.method === "PATCH") {
      return Promise.resolve(json({ gpu: 1 }));
    }
    return Promise.resolve(json([]));
  });
  vi.stubGlobal("fetch", fetcher);
  render(<PlatformPage section="infrastructure" />);
  await screen.findByRole("option", { name: "New tenant" });
  fireEvent.change(screen.getByLabelText("GPU quota tenant"), { target: { value: tenantId } });
  expect(await screen.findByText(/does not yet have any resource quota/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Save GPU quota" }) as HTMLButtonElement).disabled).toBe(true);
  for (const [label, value] of [
    ["Base quota CPU cores", "2"],
    ["Base quota Memory (GiB)", "4"],
    ["Base quota Storage (GiB)", "20"],
    ["Base quota Max apps", "8"],
    ["Base quota Max volumes", "5"],
  ]) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }
  fireEvent.change(screen.getByLabelText("GPU quota limit"), { target: { value: "1" } });
  expect((screen.getByRole("button", { name: "Save GPU quota" }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Save GPU quota" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
    "/api/platform/tenants/" + tenantId + "/quota",
    expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({
        cpu: 2, memoryBytes: 4 * 1073741824, storageBytes: 20 * 1073741824,
        maxSingleApps: 8, maxVolumes: 5, gpu: 1,
      }),
    }),
  ));
  expect(fetcher.mock.calls.some(([input]) => String(input).startsWith("/api/tenants/"))).toBe(false);
});
