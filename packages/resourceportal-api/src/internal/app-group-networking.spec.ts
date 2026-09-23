import { describe, expect, it } from "vitest";
import {
  inspectAppGroupNetworkTopology,
  inspectPersistedAppGroupNetworkTopology,
} from "./app-group-networking";

const id = "11111111-1111-4111-8111-111111111111";
const network = `rp-appgroup-${id}`;
const legacy = `rp-ingress-${id}`;

describe("inspectAppGroupNetworkTopology", () => {
  it("classifies the v0.2 single-network topology", () => {
    const stack = `services:\n  web:\n    deploy:\n      labels:\n        traefik.enable: "true"\n        traefik.swarm.network: ${network}\nnetworks:\n  default:\n    external: true\n    name: ${network}\n`;
    expect(inspectAppGroupNetworkTopology(stack, network, legacy)).toEqual({
      mode: "single",
      traefikRequired: true,
    });
  });

  it("classifies a historical two-network artifact without rewriting it", () => {
    const stack = `services:\n  web:\n    deploy:\n      labels:\n        traefik.enable: "true"\n        traefik.swarm.network: ${legacy}\nnetworks:\n  default:\n    name: ${network}\n    driver: overlay\n  ingress:\n    external: true\n    name: ${legacy}\n`;
    expect(inspectAppGroupNetworkTopology(stack, network, legacy)).toEqual({
      mode: "legacy",
      traefikRequired: true,
    });
  });

  it("rejects a public single-network artifact whose Traefik label points elsewhere", () => {
    const stack = `services:\n  web:\n    deploy:\n      labels:\n        traefik.enable: "true"\n        traefik.swarm.network: ${legacy}\nnetworks:\n  default:\n    external: true\n    name: ${network}\n`;
    expect(() =>
      inspectAppGroupNetworkTopology(stack, network, legacy),
    ).toThrow(`Traefik routing does not target ${network}`);
  });
});

describe("inspectPersistedAppGroupNetworkTopology", () => {
  it("recognizes a successful pre-v0.2 networkless deployment artifact", () => {
    const stack = `services:\n  web:\n    image: nginx:alpine\n    deploy:\n      labels:\n        traefik.http.routers.web.rule: Host(\`app.example.com\`)\n`;
    expect(
      inspectPersistedAppGroupNetworkTopology(stack, network, legacy),
    ).toEqual({
      mode: "pre-v020-networkless",
      traefikRequired: true,
    });
  });

  it("does not treat a malformed artifact with declared networks as pre-v0.2", () => {
    const stack = `services:\n  web:\n    image: nginx:alpine\nnetworks:\n  default:\n    external: true\n    name: unrelated-network\n`;
    expect(() =>
      inspectPersistedAppGroupNetworkTopology(stack, network, legacy),
    ).toThrow(`Rendered stack does not declare ${network}`);
  });
});
