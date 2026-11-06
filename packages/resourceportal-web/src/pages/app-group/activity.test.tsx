import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AppGroupActivity } from "./activity";

const operations = [
  { id: "op-group-a", resourceType: "AppGroup", resourceId: "group-a", type: "APP_GROUP_DEPLOY", status: "Succeeded" },
  { id: "op-app-a", resourceType: "SingleApp", resourceId: "app-a", type: "SINGLE_APP_RESTART", status: "Pending" },
  { id: "op-deploy-a", resourceType: "AppGroupDeployment", resourceId: "deploy-a", type: "APP_GROUP_ROLLBACK", status: "RolledBack" },
  { id: "op-group-b", resourceType: "AppGroup", resourceId: "group-b", type: "APP_GROUP_DELETE", status: "Succeeded" },
  { id: "op-app-b", resourceType: "SingleApp", resourceId: "app-b", type: "SINGLE_APP_STOP", status: "Succeeded" },
  { id: "op-domain-a", resourceType: "Domain", resourceId: "domain-a", type: "DOMAIN_VERIFY", status: "Failed" },
  { id: "op-unscoped", type: "PLATFORM_ACTION", status: "Succeeded" },
];
function json(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}
afterEach(() => vi.unstubAllGlobals());

it("shows only operations belonging to this group and its app/deployment, never an unrelated group, domain or missing association", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/api/tenants/tenant-a/operations") return json(operations);
    if (path === "/api/tenants/tenant-a/app-groups/group-a/single-apps") return json([{ id: "app-a" }]);
    if (path === "/api/tenants/tenant-a/app-groups/group-a/deployments") return json([{ id: "deploy-a" }]);
    return json([]);
  }));
  render(<AppGroupActivity tenantId="tenant-a" appGroupId="group-a" />);
  expect(await screen.findByText("SINGLE APP RESTART")).toBeTruthy();
  expect(screen.getByText("APP GROUP DEPLOY")).toBeTruthy();
  expect(screen.getByText("APP GROUP ROLLBACK")).toBeTruthy();
  expect(screen.queryByText("DOMAIN VERIFY")).toBeNull();
  expect(screen.queryByText("APP GROUP DELETE")).toBeNull();
  expect(screen.queryByText("SINGLE APP STOP")).toBeNull();
  expect(screen.queryByText("PLATFORM ACTION")).toBeNull();
  expect(screen.getByRole("link", { name: /SINGLE APP RESTART/ }).getAttribute("href")).toBe("/tenants/tenant-a/operations/op-app-a");
});

it("fails closed rather than showing whole-tenant operations when relationships cannot load", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith("/operations")) return json(operations);
    if (path.endsWith("/single-apps")) return new Response("error", { status: 503 });
    return json([]);
  }));
  render(<AppGroupActivity tenantId="tenant-a" appGroupId="group-a" />);
  await waitFor(() => expect(screen.getByText("Activity relationships could not be verified")).toBeTruthy());
  expect(screen.queryByText("APP GROUP DEPLOY")).toBeNull();
});
