import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TenantPage } from "./tenant";

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });

function mockAppGroupRequests() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/memberships")) return json([]);
    if (url.endsWith("/app-groups/ag1/stack-preview")) return new Response("services:\n  web:\n    image: nginx", { status: 200, headers: { "content-type": "text/plain" } });
    if (url.endsWith("/app-groups/ag1/single-apps")) return json([{ id: "app-1", name: "web", status: "Running" }]);
    if (url.endsWith("/app-groups/ag1/deployments")) return json([{ id: "dep-1", name: "release-1", status: "Succeeded" }]);
    if (url.endsWith("/single-apps/app-1/runtime-config")) return json({ desiredReplicas: 1, cpu: 0.1, memoryBytes: 134217728 });
    if (url.endsWith("/single-apps/app-1/http-endpoints")) return json([]);
    if (url.endsWith("/app-groups/ag1/variables") || url.endsWith("/app-groups/ag1/configs") || url.endsWith("/app-groups/ag1/secrets")) return json([]);
    if (url.endsWith("/app-groups/ag1")) return json({ id: "ag1", name: "demo", status: "Running" });
    if (url.endsWith("/deployments/dep-1") || url.endsWith("/deployments/dep-1/events")) return json({ id: "dep-1", status: "Succeeded" });
    return json([]);
  }));
}

describe("AppGroup task-oriented selection", () => {
  it("configures a SingleApp by selecting its visible row instead of entering an ID", async () => {
    mockAppGroupRequests();
    render(<TenantPage tenantId="t" section="app-groups" resourceId="ag1" userId="u" />);

    const appRow = await screen.findByRole("row", { name: /web/i });
    expect(screen.queryByLabelText("SingleApp ID")).toBeNull();

    fireEvent.click(within(appRow).getByRole("button", { name: "Configure" }));

    expect(await screen.findByText((_, element) => element?.tagName === "P" && element.textContent === "Selected application: web")).toBeTruthy();
    expect(await screen.findByText("Runtime / resource configuration")).toBeTruthy();
  });

  it("opens deployment details from the visible deployment row instead of an ID field", async () => {
    mockAppGroupRequests();
    render(<TenantPage tenantId="t" section="app-groups" resourceId="ag1" userId="u" />);

    const deploymentRow = await screen.findByRole("row", { name: /release-1/i });
    expect(screen.queryByLabelText("Deployment ID for detail/events")).toBeNull();

    fireEvent.click(within(deploymentRow).getByRole("button", { name: "View details" }));

    expect(await screen.findByText((_, element) => element?.tagName === "P" && element.textContent === "Selected deployment: release-1")).toBeTruthy();
    expect(await screen.findByText("Deployment detail")).toBeTruthy();
    expect(await screen.findByText("Deployment events")).toBeTruthy();
  });
});
