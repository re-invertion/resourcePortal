import { describe, expect, it } from "vitest";
import { validateOAuthRedirectUris } from "./redirect-uri";

describe("OAuth client redirect URI validation", () => {
  it("accepts an HTTPS confidential client callback", () => {
    expect(() => validateOAuthRedirectUris("Web", [
      "https://app.example.com/auth/callback",
    ], ["https://app.example.com/logout"], true)).not.toThrow();
  });
  it.each([
    "http://app.example.com/callback",
    "javascript://app.example.com/alert",
    "file:///etc/passwd",
    "data:text/plain,token",
    "https://user:password@app.example.com/callback",
    "https://app.example.com/callback#frag",
  ])("rejects unsafe %s", (uri) => {
    expect(() => validateOAuthRedirectUris("Web", [uri], [], true)).toThrow();
  });
  it("supports native app callback schemes and native loopback", () => {
    for (const uri of ["myrpapp://auth", "http://127.0.0.1:8800/callback"]) {
      expect(() => validateOAuthRedirectUris("Native", [uri], [], true)).not.toThrow();
    }
  });
  it("requires machine identities not to register interactive redirects", () => {
    expect(() => validateOAuthRedirectUris("Machine", ["https://x.example"], [], true)).toThrow();
  });
  it("rejects duplicated callback URIs", () => {
    expect(() => validateOAuthRedirectUris("SPA", [
      "https://x.example/callback", "https://x.example/callback",
    ], [], true)).toThrow();
  });
});
