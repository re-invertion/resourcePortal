import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function read(relative: string) {
  return readFileSync(resolve(process.cwd(), "../..", relative), "utf8");
}

describe("production auth entrypoints", () => {
  it("keeps the production stack on Zitadel/OIDC and never dev impersonation", () => {
    const stack = read("config/production/stack.yml.tpl");
    const api = stack.slice(stack.indexOf("  api:\n"), stack.indexOf("  worker:\n"));
    expect(api).toContain("NODE_ENV: production");
    expect(api).toContain("AUTH_MODE: zitadel");
    expect(api).not.toContain("AUTH_MODE: dev");
  });

  it("keeps production migration jobs free from dev auth overrides", () => {
    const controlPlane = read("scripts/installer/control-plane.sh");
    expect(controlPlane).toContain("--env NODE_ENV=production");
    expect(controlPlane).not.toContain("--env AUTH_MODE=dev");
  });

  it("uses dev auth only in explicitly non-production developer/test entrypoints", () => {
    const codespace = read("scripts/codespace-setup.sh");
    expect(codespace).toContain("NODE_ENV=development");
    expect(codespace).toContain("AUTH_MODE=dev");

    const federation = read("scripts/run-federation-e2e.sh");
    expect(federation).toContain("NODE_ENV=test");
    expect(federation).toContain("AUTH_MODE=dev");
  });
  it("isolates the production API behind the Web proxy and pins security limits", () => {
    const stack = read("config/production/stack.yml.tpl");
    const api = stack.slice(stack.indexOf("  api:\n"), stack.indexOf("  worker:\n"));
    const web = stack.slice(stack.indexOf("  web:\n"), stack.indexOf("  traefik:\n"));
    const traefik = stack.slice(stack.indexOf("  traefik:\n"));
    const networkDefinitions = stack.slice(0, stack.indexOf("secrets:\n"));

    expect(networkDefinitions).toContain("  rp-web-api:\n");
    expect(networkDefinitions).toContain("attachable: false");
    expect(api).toContain("      - rp-control\n      - rp-web-api\n");
    expect(api).not.toContain("      - rp-ingress\n");
    expect(web).toContain("      - rp-ingress\n      - rp-web-api\n");
    expect(traefik).toContain("      - rp-ingress\n");
    expect(traefik).not.toContain("rp-web-api");
    expect(api).toContain('API_TRUST_PROXY_HOPS: "1"');
    expect(api).toContain('API_RATE_LIMIT_MAX: "300"');
    expect(api).toContain('API_RATE_LIMIT_WINDOW_SECONDS: "60"');
  });

});
