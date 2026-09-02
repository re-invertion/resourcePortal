import { describe, expect, it } from "vitest";
import { resolveApiTarget } from "./proxy-target.mjs";

describe("production API proxy target", () => {
  it("preserves the configured API origin for origin-form request targets", () => {
    expect(resolveApiTarget("/api/tenants?limit=10", new URL("http://api.internal:3000"))).toBe(
      "http://api.internal:3000/api/tenants?limit=10",
    );
  });

  it("does not allow an absolute-form request target to replace the configured API origin", () => {
    expect(resolveApiTarget("http://attacker.example/api/secrets?limit=10", new URL("http://api.internal:3000"))).toBe(
      "http://api.internal:3000/api/secrets?limit=10",
    );
  });
});
