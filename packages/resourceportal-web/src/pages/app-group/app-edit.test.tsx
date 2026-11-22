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

  expect(await screen.findByRole("heading",{name:"checkout",level:1})).toBeTruthy();
  expect(screen.getByRole("main")).toBeTruthy();
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

it("#399 §9 shows current SingleApp private network and LAN grant without implying an app VPN", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path=String(input);
    if (path.endsWith("/single-apps")) return json([{id:"app1",name:"checkout",image:"nginx:latest",runtimeState:"Running"}]);
    if (path.endsWith("/networking/topology")) return json({
      appGroups:[
        {id:"ag1",singleApps:[{id:"app1",name:"checkout",networkAttachments:[{id:"att1",networkId:"net1",address:"10.2.3.4"}]}]},
        {id:"not-our-group",singleApps:[{id:"other",name:"other",networkAttachments:[{id:"att2",networkId:"net2",address:"10.0.0.3"}]}]},
      ],
      networks:[{id:"net1",name:"private-app-net"},{id:"net2",name:"unrelated-net"}],
      gates:[{id:"gate1",name:"office-gate"}],
    });
    if (path.endsWith("/networking/lan-attachments")) return json([{singleAppId:"app1",networkId:"net1",gateId:"gate1",status:"Pending"}]);
    return json([]);
  });
  vi.stubGlobal("fetch",fetchMock);
  render(<ApplicationEdit tenantId="t1" appGroupId="ag1" appId="app1" subsection="networking"/>);
  expect(await screen.findByText("private-app-net")).toBeTruthy();
  expect(screen.getByText(/LAN grant via office-gate: Pending/)).toBeTruthy();
  expect(screen.queryByText("unrelated-net")).toBeNull();
  expect(screen.getByRole("link", {name:"Manage private Network membership"}).getAttribute("href")).toBe("/tenants/t1/networking/networks");
  expect(screen.getByRole("link", {name:"Review LAN grants and Gate evidence"}).getAttribute("href")).toBe("/tenants/t1/networking/lan");
  expect(screen.getByRole("link", {name:"Device VPN access"}).getAttribute("href")).toBe("/tenants/t1/networking/vpn");
  expect(screen.getByText(/does not imply a direct VPN tunnel/)).toBeTruthy();
  expect(fetchMock.mock.calls.every(([,init])=>!init?.method||init.method==="GET")).toBe(true);
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
it("sends only advanced runtime properties, not environment, secret or compute state", async () => {
  const patches: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/single-apps") && (!init?.method || init.method === "GET")) return json([{
      id: "app1", name: "runner", image: "nginx:latest", cpu: "2",
      environment: { TOKEN: "not-for-PATCH" }, command: ["node", "--keep"],
      readOnlyRootFilesystem: true,
      healthCheck: { command: "true", intervalSeconds: 30 },
      restartPolicy: { condition: "any", delaySeconds: 5 },
      updatePolicy: { parallelism: 1, delaySeconds: 10, order: "start-first" },
    }]);
    if (path.endsWith("/single-apps/app1") && init?.method === "PATCH") {
      patches.push(JSON.parse(String(init.body))); return json({});
    }
    return json([]);
  }));
  render(<ApplicationEdit tenantId="t1" appGroupId="g1" appId="app1" subsection="advanced" />);
  expect((await screen.findByRole("textbox", { name: "Command argument 1" }) as HTMLInputElement).value).toBe("node");
  expect(screen.getByRole("checkbox", { name: /Read-only root filesystem/ })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Add argument" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Command argument 3" }), { target: { value: "two words" } });
  fireEvent.click(screen.getByRole("button", { name: "Save advanced settings" }));
  await waitFor(() => expect(patches).toHaveLength(1));
  expect(patches[0].command).toEqual(["node", "--keep", "two words"]);
  expect(patches[0].readOnlyRootFilesystem).toBe(true);
  expect(patches[0].healthCheck).toMatchObject({ command: "true", intervalSeconds: 30 });
  for (const key of ["cpu", "memoryBytes", "environment", "secrets", "image", "registryId", "name", "desiredReplicas"]) {
    expect(patches[0]).not.toHaveProperty(key);
  }
});

it("#399 §5 discloses unsupported failure-action changes and the supported draft/deploy path", async () => {
  const patches: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/single-apps") && (!init?.method || init.method === "GET")) {
      return json([{
        id: "app1", name: "runner", image: "nginx:latest",
        updatePolicy: { parallelism: 3, delaySeconds: 10, order: "start-first" },
      }]);
    }
    if (path.endsWith("/single-apps/app1") && init?.method === "PATCH") {
      patches.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return json({});
    }
    return json([]);
  }));
  render(<ApplicationEdit tenantId="t1" appGroupId="g1" appId="app1" subsection="advanced" />);
  const limitation = await screen.findByRole("note", { name: "Deployment failure action limitation" });
  expect(limitation.textContent).toContain("Failure action: Pause (fixed by the platform)");
  expect(limitation.textContent).toContain("cannot be changed in the editor");
  expect(limitation.textContent).toContain("SingleApp PATCH");
  expect(limitation.textContent).toContain("different failure action requires a platform capability change");
  expect(limitation.textContent).toContain("Save advanced settings");
  expect(limitation.textContent).toContain("deploy the App Group");
  expect(screen.queryByRole("combobox", { name: /Failure action/i })).toBeNull();

  await waitFor(() => expect((screen.getByRole("spinbutton", { name: "Update parallelism" }) as HTMLInputElement).value).toBe("3"));
  fireEvent.change(screen.getByRole("spinbutton", { name: "Update parallelism" }), { target: { value: "2" } });
  expect((screen.getByRole("spinbutton", { name: "Update parallelism" }) as HTMLInputElement).value).toBe("2");
  fireEvent.click(screen.getByRole("button", { name: "Save advanced settings" }));
  await waitFor(() => expect(patches).toHaveLength(1));
  expect(patches[0].updatePolicy).toMatchObject({ parallelism: 2, delaySeconds: 10, order: "start-first" });
  expect(patches[0].updatePolicy).not.toHaveProperty("failureAction");
  expect(patches[0].updatePolicy).not.toHaveProperty("failure_action");
});

it("rejects invalid CPU without issuing a PATCH and aligns the minimum with DTO", async () => {
  const patches: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/single-apps") && (!init?.method || init.method === "GET")) return json([{
      id: "app1", name: "runner", image: "nginx:latest", cpu: "0.75",
      memoryBytes: "536870912", desiredReplicas: 1,
    }]);
    if (path.endsWith("/single-apps/app1") && init?.method === "PATCH") {
      patches.push(JSON.parse(String(init.body))); return json({});
    }
    return json([]);
  }));
  render(<ApplicationEdit tenantId="t1" appGroupId="g1" appId="app1" subsection="compute" />);
  const cpuInput = await screen.findByRole("spinbutton", { name: "CPU cores" }) as HTMLInputElement;
  expect(cpuInput.min).toBe("0.01");
  // The component begins with an initial 0.5 CPU value. Wait for fetched
  // app data (0.75), or a late useEffect could reset the invalid user edit
  // and submit the default value instead of exercising validation.
  await waitFor(() => expect(cpuInput.value).toBe("0.75"));
  fireEvent.change(cpuInput, { target: { value: "0" } });
  await waitFor(() => expect(cpuInput.value).toBe("0"));
  fireEvent.click(screen.getByRole("button", { name: "Save compute" }));
  expect(patches).toHaveLength(0);
  fireEvent.change(cpuInput, { target: { value: "0.01" } });
  fireEvent.click(screen.getByRole("button", { name: "Save compute" }));
  await waitFor(() => expect(patches).toHaveLength(1));
  expect(patches[0]).toEqual({ cpu: 0.01, memoryBytes: 536870912, desiredReplicas: 1, runtimeState: "Running" });
});

it("rejects an enabled health check without a command", async () => {
  const patches: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/single-apps") && (!init?.method || init.method === "GET")) return json([{
      id: "app1", name: "runner", image: "nginx:latest", readOnlyRootFilesystem: true,
    }]);
    if (path.endsWith("/single-apps/app1") && init?.method === "PATCH") {
      patches.push(JSON.parse(String(init.body))); return json({});
    }
    return json([]);
  }));
  render(<ApplicationEdit tenantId="t1" appGroupId="g1" appId="app1" subsection="advanced" />);
  // Wait for the fetched advanced form to replace its initial defaults.
  // Otherwise the initial hydration effect can undo the checkbox click.
  await waitFor(() => expect((screen.getByRole("checkbox", {
    name: /Read-only root filesystem/,
  }) as HTMLInputElement).checked).toBe(true));
  fireEvent.click(await screen.findByRole("checkbox", { name: "Enable health check" }));
  // Advanced controls mount after state updates; assert the eventual input,
  // not the transient form just after clicking the checkbox.
  expect(await screen.findByRole("textbox", { name: "Health check shell command" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Save advanced settings" }));
  expect(patches).toHaveLength(0);
});


it("warns before leaving a dirty application form and clears the guard after successful save", async () => {
  const confirm = vi.fn(() => false);
  vi.stubGlobal("confirm", confirm);
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/single-apps") && (!init?.method || init.method === "GET"))
      return json([{ id: "app1", name: "checkout", image: "nginx:latest", description: "" }]);
    if (url.endsWith("/single-apps/app1") && init?.method === "PATCH") return json({});
    if (url.endsWith("/runtime-config")) return json({ environment: {} });
    return json([]);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<ApplicationEdit tenantId="t1" appGroupId="ag1" appId="app1" subsection="basics" />);
  const field = await screen.findByDisplayValue("checkout");
  fireEvent.change(field, { target: { value: "checkout-updated" } });
  expect(await screen.findByText(/Your edits have not been saved/)).toBeTruthy();
  const overview = screen.getByRole("link", { name: "Overview" });
  expect(fireEvent.click(overview)).toBe(false);
  expect(confirm).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) =>
    String(url).endsWith("/single-apps/app1") && init?.method === "PATCH")).toBe(true));
  await waitFor(() => expect(screen.queryByText(/Your edits have not been saved/)).toBeNull());
  expect(fireEvent.click(overview)).toBe(true);
  expect(confirm).toHaveBeenCalledTimes(1);
});

it("protects removal-only environment changes even without an input event", async () => {
  const confirm = vi.fn(() => false);
  vi.stubGlobal("confirm", confirm);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/single-apps")) return json([{ id: "app1", name: "checkout", image: "nginx:latest" }]);
    if (url.endsWith("/runtime-config")) return json({ environment: { TO_REMOVE: "old" } });
    return json([]);
  }));
  render(<ApplicationEdit tenantId="t1" appGroupId="ag1" appId="app1" subsection="environment" />);
  fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
  expect(await screen.findByText(/Your edits have not been saved/)).toBeTruthy();
  expect(fireEvent.click(screen.getByRole("link", { name: "Overview" }))).toBe(false);
  expect(confirm).toHaveBeenCalledTimes(1);
});


it("protects removal-only advanced command edits without an input event", async () => {
  const confirm = vi.fn(() => false);
  vi.stubGlobal("confirm", confirm);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/single-apps")) return json([{
      id: "app1", name: "checkout", image: "nginx:latest", command: ["--serve"],
    }]);
    if (url.endsWith("/runtime-config")) return json({ environment: {} });
    return json([]);
  }));
  render(<ApplicationEdit tenantId="t1" appGroupId="ag1" appId="app1" subsection="advanced" />);
  fireEvent.click(await screen.findByRole("button", { name: "Remove argument 1" }));
  expect(await screen.findByText(/Your edits have not been saved/)).toBeTruthy();
  expect(fireEvent.click(screen.getByRole("link", { name: "Overview" }))).toBe(false);
  expect(confirm).toHaveBeenCalledTimes(1);
});

it("distinguishes HTTP endpoint API failures from a valid empty application list", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/single-apps")) return json([{ id: "app1", name: "checkout", image: "nginx:latest" }]);
    if (url.endsWith("/single-apps/app1/http-endpoints")) return json({ message: "Backend temporarily unavailable" }, 503);
    return json([]);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<ApplicationEdit tenantId="t1" appGroupId="ag1" appId="app1" subsection="networking" />);
  expect(await screen.findByText("HTTP endpoints unavailable")).toBeTruthy();
  expect(screen.queryByText("No HTTP endpoints configured for this application.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry endpoints" }));
  await waitFor(() => expect(fetchMock.mock.calls.filter(([path]) =>
    String(path).endsWith("/single-apps/app1/http-endpoints")).length).toBeGreaterThanOrEqual(2));
});
