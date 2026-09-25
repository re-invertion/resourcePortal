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

function baseFetch(options?: { privileged?: boolean; exposures?: unknown[] }) {
  const privileged = options?.privileged ?? false;
  const exposures = options?.exposures ?? [];
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === root && (!init?.method || init.method === "GET")) {
      return json({ id: "ag1", networkPrivileged: privileged });
    }
    if (
      path.endsWith("/single-apps") &&
      (!init?.method || init.method === "GET")
    ) {
      return json([{ id: "app1", name: "web" }]);
    }
    if (
      path === `${root}/internal-port-exposures` &&
      (!init?.method || init.method === "GET")
    ) {
      return json(exposures);
    }
    if (
      path.endsWith("/single-apps/app1/http-endpoints") &&
      (!init?.method || init.method === "GET")
    ) {
      return json([]);
    }
    return json({});
  });
}

describe("AppGroupNetworking", () => {
  it("confirms in-app before deleting an HTTP endpoint", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === root && (!init?.method || init.method === "GET")) {
        return json({ id: "ag1", networkPrivileged: false });
      }
      if (
        path.endsWith("/internal-port-exposures") &&
        (!init?.method || init.method === "GET")
      ) {
        return json([]);
      }
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
        return json([
          {
            id: "ep1",
            name: "public",
            containerPort: 8080,
            protocolMode: "HTTP",
          },
        ]);
      }
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AppGroupNetworking tenantId="t1" appGroupId="ag1" />);

    const deleteButton = await screen.findByRole("button", {
      name: "Delete public",
    });
    fireEvent.click(deleteButton);
    expect(
      screen.getByRole("dialog", { name: "Delete endpoint public?" }),
    ).toBeTruthy();
    expect(
      fetchMock.mock.calls.some(
        ([_, init]) => (init as RequestInit | undefined)?.method === "DELETE",
      ),
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Delete endpoint" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([path, init]) =>
            String(path).endsWith("/single-apps/app1/http-endpoints/ep1") &&
            (init as RequestInit | undefined)?.method === "DELETE",
        ),
      ).toBe(true),
    );
  });

  it("shows the legacy networking section as migration-only without Add/Edit controls", async () => {
    const fetchMock = baseFetch({ privileged: true, exposures: [] });
    vi.stubGlobal("fetch", fetchMock);

    render(<AppGroupNetworking tenantId="t1" appGroupId="ag1" />);

    expect(
      await screen.findByText("Legacy Internal Port Exposures"),
    ).toBeTruthy();
    expect(screen.getByText("No legacy exposures")).toBeTruthy();
    expect(screen.getByText("Legacy privilege active")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Open tenant Networking" }).getAttribute("href"),
    ).toBe("/tenants/t1/networking");
    expect(
      screen.queryByRole("button", { name: /Add internal port/i }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /^Edit$/i })).toBeNull();
  });

  it("allows deleting an existing legacy exposure but never editing it", async () => {
    const fetchMock = baseFetch({
      privileged: true,
      exposures: [
        {
          id: "int1",
          singleAppId: "app1",
          singleAppName: "web",
          name: "dns-udp",
          containerPort: 53,
          publishedPort: 53,
          protocol: "udp",
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AppGroupNetworking tenantId="t1" appGroupId="ag1" />);

    expect(await screen.findByText("1 to migrate")).toBeTruthy();
    expect(screen.getByText("53 → 53")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Edit$/i })).toBeNull();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Delete legacy internal port dns-udp",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Delete legacy exposure" }),
    );

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([path, init]) =>
            String(path).endsWith(
              "/single-apps/app1/internal-port-exposures/int1",
            ) && (init as RequestInit | undefined)?.method === "DELETE",
        ),
      ).toBe(true),
    );
  });
});
