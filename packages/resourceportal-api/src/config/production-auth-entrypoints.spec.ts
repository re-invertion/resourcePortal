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

  it("installs and reconciles the external-IDP attestation Action using the Swarm encryption secret", () => {
    const stack = read("config/production/stack.yml.tpl");
    const identity = read("scripts/installer/identity.sh");
    const bootstrap = read("packages/resourceportal-api/scripts/bootstrap-zitadel.ts");
    const proof = read("packages/resourceportal-api/src/auth/federation-proof.service.ts");
    expect(stack).toContain("RESOURCE_ENCRYPTION_KEY_FILE: /run/secrets/rp_encryption_key");
    expect(identity).toContain("--secret source=rp_encryption_key,target=rp_encryption_key");
    expect(identity).toContain("FEDERATION_ATTESTATION_MASTER_FILE=/run/secrets/rp_encryption_key");
    expect(identity).toContain("FEDERATION_ATTESTATION_CALLBACK_URL=http://api:3000/api/auth/federation/attest");
    expect(bootstrap).toContain("await reconcileFederationAttestationAction(");
    expect(proof).toContain("deriveFederationAttestationSecret(readFileSync(masterPath))");
  });

  it("keeps production migration jobs free from dev auth overrides", () => {
    const controlPlane = read("scripts/installer/control-plane.sh");
    expect(controlPlane).toContain("--env NODE_ENV=production");
    expect(controlPlane).not.toContain("--env AUTH_MODE=dev");
  });

  it("uses dev auth only in explicitly non-production developer/test entrypoints", () => {
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
