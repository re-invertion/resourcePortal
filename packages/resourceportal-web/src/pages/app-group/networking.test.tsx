import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppGroupNetworking } from "./networking";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const root = "/api/tenants/t1/app-groups/ag1";

afterEach(() => vi.unstubAllGlobals());

function fetchWithEndpoints(endpoints: unknown[] = []) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (
      path.endsWith("/single-apps") &&
      (!init?.method || init.method === "GET")
    ) {
      return json([{ id: "app1", name: "web" }]);
    }
    if (
      path.endsWith("/single-apps/app1/http-endpoints") &&
      (!init?.method || init.method === "GET")
    ) {
      return json(endpoints);
    }
    return json({});
  });
}

describe("AppGroupNetworking", () => {
  it("confirms in-app before deleting an HTTP endpoint", async () => {
    const fetchMock = fetchWithEndpoints([
      {
        id: "ep1",
        name: "public",
        containerPort: 8080,
        protocolMode: "HTTP",
      },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    render(<AppGroupNetworking tenantId="t1" appGroupId="ag1" />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Delete public" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Delete endpoint public?" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Delete endpoint" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([path, init]) =>
            String(path) === root + "/single-apps/app1/http-endpoints/ep1" &&
            (init as RequestInit | undefined)?.method === "DELETE",
        ),
      ).toBe(true),
    );
  });

  it("routes private network membership to tenant Networking and contains no deprecated controls", async () => {
    vi.stubGlobal("fetch", fetchWithEndpoints());
    render(<AppGroupNetworking tenantId="t1" appGroupId="ag1" />);

    expect(await screen.findByText("No HTTP endpoints")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Open tenant Networking" }).getAttribute("href"),
    ).toBe("/tenants/t1/networking");
    expect(screen.queryByText(/legacy/i)).toBeNull();
    expect(screen.queryByText(/privileged/i)).toBeNull();
  });
});
