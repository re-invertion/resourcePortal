import { describe, expect, it } from "vitest";
import { appGroupHref, applicationHref, parseRoute, tenantHref } from "./router";

describe("route parser", () => {
  it("keeps tenant context and deep routed workspace segments in the URL", () => {
    expect(parseRoute("/tenants/tenant-1/app-groups/ag-1/apps/app-1/edit/resources")).toEqual({
      kind: "tenant",
      tenantId: "tenant-1",
      section: "app-groups",
      resourceId: "ag-1",
      segments: ["ag-1", "apps", "app-1", "edit", "resources"],
    });
  });

  it("separates platform administration routes and preserves detail segments", () => {
    expect(parseRoute("/platform/storage-backends/backend-1/settings")).toEqual({
      kind: "platform",
      section: "storage-backends",
      resourceId: "backend-1",
      segments: ["backend-1", "settings"],
    });
  });

  it("recognizes public and tenant-selection routes", () => {
    expect(parseRoute("/login")).toEqual({ kind: "public", page: "login" });
    expect(parseRoute("/tenants")).toEqual({ kind: "tenants" });
    expect(parseRoute("/invitations/opaque-token")).toEqual({ kind: "invitation", token: "opaque-token" });
  });

  it("builds canonical tenant, App Group and application URLs", () => {
    expect(tenantHref("t 1", "applications")).toBe("/tenants/t%201/applications");
    expect(appGroupHref("t1", "ag1", "deployments/d1")).toBe("/tenants/t1/app-groups/ag1/deployments/d1");
    expect(applicationHref("t1", "ag1", "app1", "edit/configuration")).toBe("/tenants/t1/app-groups/ag1/apps/app1/edit/configuration");
  });
});