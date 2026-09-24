import { describe, expect, it } from "vitest";
import { isZitadelNoChangesResponse } from "./zitadel-api-response";

describe("ZITADEL idempotent responses", () => {
  it("accepts numeric gRPC failed-precondition no-changes responses", () => {
    expect(
      isZitadelNoChangesResponse(400, {
        code: 9,
        message: "No changes (POLICY-EWsf3)",
      }),
    ).toBe(true);
  });

  it("accepts Connect JSON failed-precondition no-changes responses", () => {
    expect(
      isZitadelNoChangesResponse(400, {
        code: "failed_precondition",
        message: "No changes (COMMAND-1m88i)",
      }),
    ).toBe(true);
  });

  it("does not swallow unrelated API failures", () => {
    expect(isZitadelNoChangesResponse(405, { code: 12, message: "Method Not Allowed" })).toBe(false);
    expect(isZitadelNoChangesResponse(400, { code: 9, message: "Different precondition" })).toBe(false);
    expect(
      isZitadelNoChangesResponse(400, {
        code: "invalid_argument",
        message: "No changes",
      }),
    ).toBe(false);
    expect(isZitadelNoChangesResponse(500, { code: 9, message: "No changes" })).toBe(false);
  });
});
