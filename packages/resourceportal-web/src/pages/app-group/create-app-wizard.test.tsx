import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CreateApplicationWizard } from "./create-app-wizard";
import { ToastViewport } from "../../components/toast";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function initialResponse(path: string) {
  if (path === "/api/tenants/t1/registries") return json([]);
  if (path === "/api/tenants/t1/volumes") return json([{ id: "vol-1", name: "data" }]);
  if (path === "/api/tenants/t1/app-groups/ag1/variables") {
    return json([{ id: "var-1", name: "DATABASE_URL" }]);
  }
  if (path === "/api/tenants/t1/app-groups/ag1/configs") {
    return json([{ id: "cfg-1", name: "APP_CONFIG" }]);
  }
  if (path === "/api/tenants/t1/app-groups/ag1/secrets") {
    return json([{ id: "sec-1", name: "API_TOKEN" }]);
  }
  return undefined;
}

describe("CreateApplicationWizard", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => initialResponse(String(input)) ?? json([])),
    );
  });

  function enterBasics() {
    fireEvent.change(screen.getByPlaceholderText("web-api"), { target: { value: "web-api" } });
    fireEvent.change(screen.getByPlaceholderText("ghcr.io/example/web-api:1.4.2"), { target: { value: "ghcr.io/acme/web:1" } });
  }

  async function openStorage() {
    render(<><CreateApplicationWizard tenantId="t1" appGroupId="ag1" /><ToastViewport /></>);
    enterBasics();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByRole("heading", { name: "Volumes" })).toBeTruthy();
  }

  async function openConfiguration() {
    await openStorage();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByRole("heading", { name: "Config" })).toBeTruthy();
  }

  it("blocks leaving Storage when a selected volume uses a relative mount path", async () => {
    await openStorage();
    fireEvent.click(screen.getByRole("button", { name: "Attach volume" }));
    fireEvent.change(screen.getByLabelText(/Volume/), { target: { value: "vol-1" } });
    fireEvent.change(screen.getByLabelText(/Mount path/), { target: { value: "data" } });

    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/absolute path beginning with \//i)).toBeTruthy();
  });

  it("blocks leaving Configuration when a selected variable has no target name", async () => {
    await openConfiguration();
    fireEvent.click(screen.getAllByRole("button", { name: "+ Add" })[0]);
    fireEvent.change(screen.getByLabelText(/Variable/), { target: { value: "var-1" } });
    fireEvent.change(screen.getByLabelText(/Target name/), { target: { value: "" } });

    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/environment-style name/i)).toBeTruthy();
  });

  it("blocks leaving Configuration when a selected config has no target path", async () => {
    await openConfiguration();
    fireEvent.click(screen.getAllByRole("button", { name: "+ Add" })[1]);
    fireEvent.change(screen.getByLabelText(/Config/), { target: { value: "cfg-1" } });
    fireEvent.change(screen.getByLabelText(/Target path/), { target: { value: "" } });

    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/target path is required/i)).toBeTruthy();
  });

  it("blocks leaving Configuration when a selected secret uses an invalid target name", async () => {
    await openConfiguration();
    fireEvent.click(screen.getAllByRole("button", { name: "+ Add" })[2]);
    fireEvent.change(screen.getByLabelText(/Secret/), { target: { value: "sec-1" } });
    const targetFields = screen.getAllByLabelText(/Target name/);
    fireEvent.change(targetFields[targetFields.length - 1], { target: { value: "bad target!" } });

    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/letters, numbers, dots, underscores or hyphens/i)).toBeTruthy();
  });

  it("runs attachments sequentially and compensates a partial create when a later attachment fails", async () => {
    const mutations: Array<{ path: string; method: string; body?: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        const initial = initialResponse(path);
        if (initial) return initial;
        const method = (init?.method ?? "GET").toUpperCase();
        let body: unknown;
        if (typeof init?.body === "string") body = JSON.parse(init.body);
        mutations.push({ path, method, body });
        if (path.endsWith("/single-apps") && method === "POST") return json({ id: "app-new", name: "web-api" });
        if (path.endsWith("/single-apps/app-new/variable-attachments") && method === "POST") return json({ id: "va-1" });
        if (path.endsWith("/single-apps/app-new/config-attachments") && method === "POST") {
          return json({ error: { message: "Config attachment rejected" } }, 400);
        }
        if (path.endsWith("/single-apps/app-new") && method === "DELETE") return json({ id: "app-new" });
        return json([]);
      }),
    );

    await openConfiguration();
    fireEvent.click(screen.getAllByRole("button", { name: "+ Add" })[0]);
    fireEvent.change(screen.getByLabelText(/Variable/), { target: { value: "var-1" } });
    fireEvent.click(screen.getAllByRole("button", { name: "+ Add" })[1]);
    fireEvent.change(screen.getByLabelText(/Config/), { target: { value: "cfg-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Create application" }));

    expect(await screen.findByText(/Partial application creation was cleaned up/i)).toBeTruthy();
    expect(screen.getByText(/marked for deletion/i)).toBeTruthy();
    await waitFor(() => expect(mutations).toHaveLength(4));
    expect(mutations.map(({ path, method }) => [method, path])).toEqual([
      ["POST", "/api/tenants/t1/app-groups/ag1/single-apps"],
      ["POST", "/api/tenants/t1/app-groups/ag1/single-apps/app-new/variable-attachments"],
      ["POST", "/api/tenants/t1/app-groups/ag1/single-apps/app-new/config-attachments"],
      ["DELETE", "/api/tenants/t1/app-groups/ag1/single-apps/app-new"],
    ]);
    expect(mutations[1].body).toEqual({ variableId: "var-1", targetName: "DATABASE_URL" });
    expect(mutations[2].body).toEqual({ configId: "cfg-1", targetPath: "/app/config" });
  });


  it("matches the Penpot Details step hierarchy", async () => {
  render(<CreateApplicationWizard tenantId="t1" appGroupId="ag1" appGroupName="commerce-prod" />);
  expect(await screen.findByRole("heading", { name: "Create application" })).toBeTruthy();
  for (const label of ["Details", "Volumes", "Config", "Resources", "Review"]) expect(screen.getByText(label)).toBeTruthy();
  expect(screen.getByText(/create a workload for commerce-prod/i)).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Application details" })).toBeTruthy();
  expect(screen.getByTestId("application-details-grid").className).toContain("md:grid-cols-2");
  });

  it("matches the Penpot Review & create summary and edit affordances", async () => {
  render(<CreateApplicationWizard tenantId="t1" appGroupId="ag1" appGroupName="commerce-prod" />);
  enterBasics();
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByRole("heading", { name: "Volumes" });
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByRole("heading", { name: "Config" });
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByRole("heading", { name: "Resources" });
  fireEvent.click(screen.getByRole("button", { name: "Next" }));

  expect(await screen.findByRole("heading", { name: "Review & create" })).toBeTruthy();
  for (const title of ["Application details", "Volumes", "Configuration", "Container resources"]) expect(screen.getByRole("heading", { name: title, level: 4 })).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "Edit" })).toHaveLength(4);
  });
});
