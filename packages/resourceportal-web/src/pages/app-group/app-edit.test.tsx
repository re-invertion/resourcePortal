import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ApplicationEdit } from "./app-edit";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

it("lists existing configuration attachments and detaches them by attachment id", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/single-apps") && method === "GET") {
      return json([{
        id: "app1",
        name: "checkout",
        image: "nginx:latest",
        runtimeState: "Running",
        effectiveRuntimeState: "Running",
        variableAttachments: [{
          id: "att-var-1",
          targetName: "DATABASE_URL",
          variable: { id: "var-1", name: "DATABASE_URL" },
        }],
        secretAttachments: [],
        configAttachments: [],
        volumeAttachments: [],
      }]);
    }
    if (url.endsWith("/runtime-config")) return json({ environment: {} });
    if (url.endsWith("/registries")) return json([]);
    if (url.endsWith("/volumes")) return json([]);
    if (url.endsWith("/variables")) return json([{ id: "var-1", name: "DATABASE_URL" }]);
    if (url.endsWith("/secrets")) return json([]);
    if (url.endsWith("/configs")) return json([]);
    if (url.endsWith("/http-endpoints")) return json([]);
    if (url.endsWith("/variable-attachments/att-var-1") && method === "DELETE") return json({ deleted: true });
    return json([]);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<ApplicationEdit tenantId="t1" appGroupId="ag1" appId="app1" subsection="configuration" />);

  expect(await screen.findByText("Current attachments")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Detach DATABASE_URL" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Detach DATABASE_URL" }));
  fireEvent.click(await screen.findByRole("button", { name: "Detach resource" }));

  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([input, init]) =>
      String(input).endsWith("/single-apps/app1/variable-attachments/att-var-1") &&
      init?.method === "DELETE",
    )).toBe(true),
  );
});

it("encodes removed and renamed environment keys with explicit null in the merge PATCH (#263)", async () => {
  const patches: Array<Record<string, unknown>> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/single-apps") && (!init || init.method === "GET")) {
      return json([{ id: "app1", name: "checkout", image: "nginx:latest", runtimeState: "Running" }]);
    }
    if (url.endsWith("/runtime-config")) {
      if (init?.method === "PATCH") {
        patches.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      }
      return json({ environment: { KEEP: "1", REMOVE: "2", RENAME: "old" } });
    }
    return json([]);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<ApplicationEdit tenantId="t1" appGroupId="g1" appId="app1" subsection="environment" />);
  await waitFor(() => expect(screen.getByDisplayValue("RENAME")).toBeTruthy());
  fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[1]);
  fireEvent.change(screen.getByDisplayValue("RENAME"), { target: { value: "RENAMED" } });
  fireEvent.click(screen.getByRole("button", { name: "Save environment" }));
  await waitFor(() => expect(patches).toHaveLength(1));
  expect(patches[0].environment).toEqual({
    KEEP: "1", REMOVE: null, RENAME: null, RENAMED: "old",
  });
});

it("can clear optional application string settings without dropping PATCH fields (#264)", async () => {
  const patches: Array<Record<string, unknown>> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/single-apps") && (!init || init.method === "GET")) {
      return json([{ id: "app1", name: "checkout", image: "nginx:latest",
        runtimeState: "Running", entrypoint: "/custom", workingDir: "/old", user: "00123",
        description: "Legacy", registryId: null }]);
    }
    if (url.endsWith("/single-apps/app1") && init?.method === "PATCH") {
      patches.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return json({});
    }
    return json([]);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<ApplicationEdit tenantId="t1" appGroupId="g1" appId="app1" subsection="advanced" />);
  await waitFor(() => expect(screen.getByDisplayValue("/custom")).toBeTruthy());
  fireEvent.change(screen.getByDisplayValue("/custom"), { target: { value: "" } });
  fireEvent.change(screen.getByDisplayValue("/old"), { target: { value: "" } });
  fireEvent.change(screen.getByDisplayValue("00123"), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Save advanced settings" }));
  await waitFor(() => expect(patches).toHaveLength(1));
  expect(patches[0]).toMatchObject({ entrypoint: null, workingDir: null, user: null });
});

it("shows a persistent draft deployment banner with the whole App Group scope", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/single-apps")) {
      return json([{ id: "app1", name: "checkout", image: "nginx:latest", runtimeState: "Running" }]);
    }
    return json([]);
  }));
  render(<ApplicationEdit tenantId="t1" appGroupId="ag1" appId="app1" appGroupName="commerce" subsection="basics" hasPendingChanges />);
  expect(await screen.findByText("Changes saved, not yet deployed")).toBeTruthy();
  expect(screen.getByText(/all applications in App Group/).textContent).toContain("commerce");
  expect(screen.getByRole("link", { name: "Review and deploy" }).getAttribute("href")).toBe("/tenants/t1/app-groups/ag1/deployments");
  expect(screen.getByText(/Start, Stop and Restart actions apply immediately/)).toBeTruthy();
});

it("opens attachment forms only when requested on Storage and Configuration", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/single-apps")) return json([{id:"app1",name:"checkout",image:"nginx:latest",runtimeState:"Running"}]);
    return json([]);
  }));
  const { rerender }=render(<ApplicationEdit tenantId="t1" appGroupId="ag1" appId="app1" subsection="storage" />);
  const storageAction=await screen.findByRole("button",{name:"Attach volume"});
  expect(screen.queryByRole("dialog",{name:"Attach volume"})).toBeNull();
  fireEvent.click(storageAction);
  expect(screen.getByRole("dialog",{name:"Attach volume"})).toBeTruthy();
  fireEvent.click(screen.getByRole("button",{name:"Close dialog"}));
  expect(screen.queryByRole("dialog",{name:"Attach volume"})).toBeNull();
  rerender(<ApplicationEdit tenantId="t1" appGroupId="ag1" appId="app1" subsection="configuration" />);
  fireEvent.click(screen.getByRole("button",{name:"Attach configuration"}));
  expect(screen.getByRole("dialog",{name:"Attach configuration"})).toBeTruthy();
});

it("loads GPU inventory from the tenant-level collection endpoint", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/tenants/t1/app-groups/gpu-devices") {
      return json({ enabled: true, quota: 1, devices: [] });
    }
    if (url.endsWith("/single-apps")) {
      return json([{ id: "app1", name: "checkout", gpu: 0, image: "nginx:latest" }]);
    }
    if (url.endsWith("/gpu-devices")) return json({}, 404);
    return json([]);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<ApplicationEdit tenantId="t1" appGroupId="ag1" appId="app1" />);
  await waitFor(() => expect(fetchMock.mock.calls.some(([input]) =>
    String(input) === "/api/tenants/t1/app-groups/gpu-devices",
  )).toBe(true));
  expect(fetchMock.mock.calls.some(([input]) =>
    String(input).includes("/app-groups/ag1/gpu-devices"),
  )).toBe(false);
});