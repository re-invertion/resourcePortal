import { describe, expect, it } from "vitest";
import { resolveProxyHeaders } from "./proxy-target.mjs";

describe("resolveProxyHeaders", () => {
  it("injects the configured dev user only in non-production mode", () => {
    expect(resolveProxyHeaders({ accept: "application/json", "x-dev-user-id": "spoofed" }, {
      NODE_ENV: "development",
      RESOURCE_PORTAL_DEV_USER_ID: "00000000-0000-4000-8000-000000000001",
    })).toMatchObject({
      accept: "application/json",
      "x-dev-user-id": "00000000-0000-4000-8000-000000000001",
    });

    expect(resolveProxyHeaders({ accept: "application/json" }, {
      NODE_ENV: "production",
      RESOURCE_PORTAL_DEV_USER_ID: "00000000-0000-4000-8000-000000000001",
    })).toEqual({ accept: "application/json" });
  });

  it("does not add a dev identity when it is not configured", () => {
    expect(resolveProxyHeaders({ accept: "application/json" }, {
      NODE_ENV: "development",
    })).toEqual({ accept: "application/json" });
  });
});
