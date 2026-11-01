import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { startTerminalAgent } from "./terminal-agent.runner";

let server: Server | undefined;
afterEach(async () => { if (server) await new Promise<void>((resolve) => server!.close(() => resolve())); server = undefined; });

describe("private Swarm terminal agent HTTP security", () => {
  it("requires a secret configured at startup", () => {
    expect(() => startTerminalAgent(0, "weak")).toThrow("requires authenticated");
  });
  it("blocks unauthenticated requests and malformed identities without invoking Docker", async () => {
    server = startTerminalAgent(0, "some-very-long-internal-worker-token");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test listener");
    const url = `http://127.0.0.1:${address.port}/internal/container-terminal`;
    const forbidden = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "containers" }) });
    expect(forbidden.status).toBe(403);
    const capacityForbidden = await fetch(
      `http://127.0.0.1:${address.port}/internal/capacity-probe`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    expect(capacityForbidden.status).toBe(403);
    const permitted = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-internal-token": "some-very-long-internal-worker-token" }, body: JSON.stringify({ actor: "<invalid>", service: "host", action: "containers" }) });
    expect(permitted.status).toBe(422);
    expect(await permitted.json()).toMatchObject({ message: "Invalid terminal identity" });
  });
});