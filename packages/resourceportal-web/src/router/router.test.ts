import { describe, expect, it } from "vitest";
import { parseRoute } from "./router";

describe("route parser", () => {
  it("keeps tenant context in the URL", () => {
    expect(parseRoute("/tenants/tenant-1/app-groups/ag-1")).toEqual({
      kind: "tenant",
      tenantId: "tenant-1",
      section: "app-groups",
      resourceId: "ag-1",
    });
  });

  it("separates platform administration routes", () => {
    expect(parseRoute("/platform/storage-backends/backend-1")).toEqual({
      kind: "platform",
      section: "storage-backends",
      resourceId: "backend-1",
    });
  });

  it("recognizes public and tenant-selection routes", () => {
    expect(parseRoute("/login")).toEqual({ kind: "public", page: "login" });
    expect(parseRoute("/tenants")).toEqual({ kind: "tenants" });
  });
});
