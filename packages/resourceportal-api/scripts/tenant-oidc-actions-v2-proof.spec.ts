import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyActionSignature } from "./tenant-oidc-actions-v2-proof";

const key = "ephemeral-test-only-secret";
const timestamp = 1_700_000_000;
const raw = Buffer.from('{"function":"function/preaccesstoken","user":{"id":"123"}}');
const signed = (value: Buffer, t = timestamp) => {
  const mac = createHmac("sha256", key).update(t + ".").update(value).digest("hex");
  return "t=" + t + ",v1=" + mac;
};

describe("ZITADEL Actions V2 #398 integrity gate", () => {
  it("accepts only an exact signed byte payload with fresh timestamp", () => {
    expect(verifyActionSignature(raw, signed(raw), key, timestamp * 1000)).toBe(true);
  });

  it("denies unsigned, altered body, wrong key and invalid signatures", () => {
    const header = signed(raw);
    const now = timestamp * 1000;
    expect(verifyActionSignature(raw, undefined, key, now)).toBe(false);
    expect(verifyActionSignature(raw, header, "another-key", now)).toBe(false);
    expect(verifyActionSignature(Buffer.concat([raw, Buffer.from(" ")]), header, key, now)).toBe(false);
    expect(verifyActionSignature(raw, header.replace(/.$/, "x"), key, now)).toBe(false);
    expect(verifyActionSignature(raw, "t=oops,v1=123", key, now)).toBe(false);
  });

  it("rejects replay outside the 5-minute clock boundary", () => {
    expect(verifyActionSignature(raw, signed(raw), key, (timestamp + 301) * 1000)).toBe(false);
    expect(verifyActionSignature(raw, signed(raw), key, (timestamp - 301) * 1000)).toBe(false);
  });
});
