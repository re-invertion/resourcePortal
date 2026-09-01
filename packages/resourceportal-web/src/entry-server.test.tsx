import { describe, expect, it } from "vitest";
import { render } from "./entry-server";

describe("SSR route rendering", () => {
  it("renders a tenant deep link into route-specific server HTML", () => {
    const result = render("/tenants/tenant-1/app-groups");

    expect(result.status).toBe(200);
    expect(result.html).toContain('data-route-kind="tenant"');
    expect(result.html).toContain('data-tenant-id="tenant-1"');
    expect(result.html).toContain('data-route-section="app-groups"');
    expect(result.html).toContain("Loading tenant route: app-groups");
  });

  it("returns a 404 status for an unknown document route", () => {
    const result = render("/definitely-not-a-resource-portal-route");

    expect(result.status).toBe(404);
    expect(result.html).toContain('data-route-kind="not-found"');
  });
});
