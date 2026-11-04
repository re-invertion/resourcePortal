import { describe, expect, it } from "vitest";
import { AgentRequestVerifier, isEncryptedTerminalOverlay, signedAgentHeaders } from "./terminal-agent-security";

const secret = "a-dedicated-long-random-internal-worker-secret";
const target = "10.20.30.40";
const path = "/internal/container-terminal";
const payload = JSON.stringify({ action: "execute", service: "rp_service", actor: "tenant", command: "id" });
const nonce = "8".repeat(32);
const now = 1793815000000;

describe("Swarm node agent signed request boundary (#360)", () => {
  it("accepts only single-use, fresh, destination-scoped requests for the exact payload", () => {
    const verify = new AgentRequestVerifier(secret);
    const headers = signedAgentHeaders(secret, path, payload, target, now, nonce);
    expect(JSON.stringify(headers)).not.toContain(secret);
    expect(verify.verify(headers, "POST", path, payload, target, now)).toBe(true);
    expect(verify.verify(headers, "POST", path, payload, target, now)).toBe(false);
  });
  it("refuses tampering, replay at another node, old timestamps, wrong key and bearer compatibility", () => {
    const headers = signedAgentHeaders(secret, path, payload, target, now, nonce);
    const verifier = new AgentRequestVerifier(secret);
    expect(verifier.verify(headers, "POST", path, payload.replace("id", "cat /etc/passwd"), target, now)).toBe(false);
    expect(verifier.verify(headers, "POST", "/internal/gpu-probe", payload, target, now)).toBe(false);
    expect(verifier.verify(headers, "POST", path, payload, "10.20.30.41", now)).toBe(false);
    expect(verifier.verify(headers, "POST", path, payload, target, now + 31000)).toBe(false);
    expect(verifier.verify(signedAgentHeaders("wrong-worker-secret-for-test", path, payload, target, now, "9".repeat(32)), "POST", path, payload, target, now)).toBe(false);
    expect(verifier.verify({ "x-internal-token": secret }, "POST", path, payload, target, now)).toBe(false);
    expect(verifier.verify(headers, "POST", path, payload, target, now)).toBe(true);
  });
  it("rejects missing encryption or incorrect overlay rather than assuming control-plane TLS", () => {
    const name = "resourceportal-control-plane_rp-terminal-secure";
    const base = { Name: name, Driver: "overlay", Scope: "swarm", Attachable: false, Options: { encrypted: "true" } };
    expect(isEncryptedTerminalOverlay(base, name)).toBe(true);
    expect(isEncryptedTerminalOverlay({ ...base, Options: { encrypted: "" } }, name)).toBe(true);
    expect(isEncryptedTerminalOverlay({ ...base, Options: {} }, name)).toBe(false);
    expect(isEncryptedTerminalOverlay({ ...base, Options: { encrypted: "false" } }, name)).toBe(false);
    expect(isEncryptedTerminalOverlay({ ...base, Attachable: true }, name)).toBe(false);
    expect(isEncryptedTerminalOverlay({ ...base, Name: "attacker_overlay" }, name)).toBe(false);
  });
});
