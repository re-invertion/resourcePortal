import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppGroupNetworking, protocolModeLabel } from "./networking";

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
  it("maps protocol modes to readable labels without changing API enum values", () => {
    expect(protocolModeLabel("HTTP")).toBe("HTTP only");
    expect(protocolModeLabel("HTTPS")).toBe("HTTPS only");
    expect(protocolModeLabel("HTTP_AND_HTTPS")).toBe("HTTP + HTTPS");
    expect(protocolModeLabel("HTTP_REDIRECT_TO_HTTPS")).toBe("HTTP → HTTPS redirect");
    expect(protocolModeLabel("unexpected")).toBe("Unknown protocol mode");
  });

  it("displays the readable HTTP redirect label in the endpoint table", async () => {
    vi.stubGlobal("fetch", fetchWithEndpoints([{
      id: "ep-redirect", name: "public", containerPort: 8080,
      protocolMode: "HTTP_REDIRECT_TO_HTTPS",
    }]));
    render(<AppGroupNetworking tenantId="t1" appGroupId="ag1" />);
    expect(await screen.findByText("HTTP → HTTPS redirect")).toBeTruthy();
    expect(screen.queryByText("HTTP_REDIRECT_TO_HTTPS")).toBeNull();
  });

  it("links endpoint application to its tenant and App Group without changing routing", async () => {
    const fetchMock = fetchWithEndpoints([{
      id: "ep1", name: "public", containerPort: 8080,
      protocolMode: "HTTP",
    }]);
    vi.stubGlobal("fetch", fetchMock);
    render(<AppGroupNetworking tenantId="t1" appGroupId="ag1" />);
    const application = await screen.findByRole("link", { name: "web" });
    expect(application.getAttribute("href")).toBe("/tenants/t1/app-groups/ag1/apps/app1");
    expect(screen.getByText("public")).toBeTruthy();
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });

  it("uses friendly protocol labels in endpoint editor without altering API enum values", async () => {
    const fetchMock = fetchWithEndpoints();
    vi.stubGlobal("fetch", fetchMock);
    render(<AppGroupNetworking tenantId="t1" appGroupId="ag1" />);
    fireEvent.click(await screen.findByRole("button", { name: /Add endpoint/i }));
    const protocol = screen.getByRole("combobox", { name: "Protocol mode" }) as HTMLSelectElement;
    expect(protocol.value).toBe("HTTP_REDIRECT_TO_HTTPS");
    expect(Array.from(protocol.options).map((option) => [option.value, option.textContent])).toEqual([
      ["HTTP", "HTTP only"],
      ["HTTPS", "HTTPS only"],
      ["HTTP_AND_HTTPS", "HTTP + HTTPS"],
      ["HTTP_REDIRECT_TO_HTTPS", "HTTP → HTTPS redirect"],
    ]);
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });

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
