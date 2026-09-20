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

describe("AppGroupNetworking", () => {
  it("confirms in-app before deleting an endpoint", async () => {
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
    const nativeConfirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    render(<AppGroupNetworking tenantId="t1" appGroupId="ag1" />);

    const deleteButton = await screen.findByRole("button", {
      name: "Delete public",
    });
    fireEvent.click(deleteButton);
    expect(
      screen.getByRole("dialog", { name: "Delete endpoint public?" }),
    ).toBeTruthy();
    expect(nativeConfirm).not.toHaveBeenCalled();
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

  it("does not expose internal port controls for a standard App Group", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === root) return json({ id: "ag1", networkPrivileged: false });
      if (path.endsWith("/single-apps")) {
        return json([{ id: "app1", name: "dns" }]);
      }
      if (path.endsWith("/internal-port-exposures")) return json([]);
      if (path.endsWith("/http-endpoints")) return json([]);
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AppGroupNetworking tenantId="t1" appGroupId="ag1" />);

    expect(await screen.findByText("Platform Admin required")).toBeTruthy();
    expect(screen.getByText("Privileged networking is disabled")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Add internal port" }),
    ).toBeNull();
  });

  it("creates UDP/53 internal exposure for a privileged App Group", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === root && (!init?.method || init.method === "GET")) {
        return json({ id: "ag1", networkPrivileged: true });
      }
      if (
        path.endsWith("/single-apps") &&
        (!init?.method || init.method === "GET")
      ) {
        return json([{ id: "app1", name: "dns" }]);
      }
      if (
        path === `${root}/internal-port-exposures` &&
        (!init?.method || init.method === "GET")
      ) {
        return json([]);
      }
      if (
        path.endsWith("/single-apps/app1/http-endpoints") &&
        (!init?.method || init.method === "GET")
      ) {
        return json([]);
      }
      if (
        path.endsWith("/single-apps/app1/internal-port-exposures") &&
        init?.method === "POST"
      ) {
        return json({ id: "int1" });
      }
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AppGroupNetworking tenantId="t1" appGroupId="ag1" />);

    const add = await screen.findByRole("button", { name: "Add internal port" });
    await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(add);
    await screen.findByText("Exposure name");
    fireEvent.change(screen.getByLabelText(/Exposure name/i), {
      target: { value: "dns-udp" },
    });
    fireEvent.change(screen.getByLabelText(/^Protocol$/i), {
      target: { value: "udp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create internal port" }));

    await waitFor(() => {
      const request = fetchMock.mock.calls.find(
        ([path, init]) =>
          String(path).endsWith("/single-apps/app1/internal-port-exposures") &&
          init?.method === "POST",
      );
      expect(request).toBeTruthy();
      expect(JSON.parse(String(request?.[1]?.body))).toEqual({
        name: "dns-udp",
        containerPort: 53,
        publishedPort: 53,
        protocol: "udp",
      });
    });
  });

  it("shows internal port publishing only after Platform Admin grants privileged networking", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/app-groups/ag1") && (!init?.method || init.method === "GET")) {
        return json({ id: "ag1", networkPrivileged: false });
      }
      if (path.endsWith("/single-apps") && (!init?.method || init.method === "GET")) {
        return json([{ id: "app1", name: "dns" }]);
      }
      if (path.endsWith("/internal-port-exposures") && (!init?.method || init.method === "GET")) {
        return json([]);
      }
      if (path.endsWith("/single-apps/app1/http-endpoints") && (!init?.method || init.method === "GET")) {
        return json([]);
      }
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AppGroupNetworking tenantId="t1" appGroupId="ag1" />);

    expect(await screen.findByText("Privileged networking is disabled")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Add internal port/i })).toBeNull();
  });

  it("creates a UDP/53 internal exposure for a privileged App Group", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/app-groups/ag1") && (!init?.method || init.method === "GET")) {
        return json({ id: "ag1", networkPrivileged: true });
      }
      if (path.endsWith("/single-apps") && (!init?.method || init.method === "GET")) {
        return json([{ id: "app1", name: "dns" }]);
      }
      if (path.endsWith("/internal-port-exposures") && (!init?.method || init.method === "GET")) {
        return json([]);
      }
      if (path.endsWith("/single-apps/app1/http-endpoints") && (!init?.method || init.method === "GET")) {
        return json([]);
      }
      if (
        path.endsWith("/single-apps/app1/internal-port-exposures") &&
        init?.method === "POST"
      ) {
        return json({
          id: "port1",
          singleAppId: "app1",
          name: "dns-udp",
          containerPort: 53,
          publishedPort: 53,
          protocol: "udp",
        });
      }
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AppGroupNetworking tenantId="t1" appGroupId="ag1" />);

    const add = await screen.findByRole("button", { name: /Add internal port/i });
    fireEvent.click(add);
    fireEvent.change(screen.getByPlaceholderText("dns-udp"), {
      target: { value: "dns-udp" },
    });
    const protocolSelect = screen
      .getAllByRole("combobox")
      .find((element) => (element as HTMLSelectElement).value === "tcp");
    expect(protocolSelect).toBeTruthy();
    fireEvent.change(protocolSelect as HTMLSelectElement, {
      target: { value: "udp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create internal port" }));

    await waitFor(() => {
      const request = fetchMock.mock.calls.find(
        ([path, init]) =>
          String(path).endsWith("/single-apps/app1/internal-port-exposures") &&
          (init as RequestInit | undefined)?.method === "POST",
      );
      expect(request).toBeTruthy();
      expect(JSON.parse(String((request?.[1] as RequestInit | undefined)?.body))).toEqual({
        name: "dns-udp",
        containerPort: 53,
        publishedPort: 53,
        protocol: "udp",
      });
    });
  });

});
