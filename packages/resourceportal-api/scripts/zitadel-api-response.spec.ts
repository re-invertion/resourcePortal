import { describe, expect, it } from "vitest";
import { isZitadelNoChangesResponse } from "./zitadel-api-response";

describe("ZITADEL idempotent responses", () => {
  it("accepts the ZITADEL failed-precondition no-changes response", () => {
    expect(
      isZitadelNoChangesResponse(400, {
        code: 9,
        message: "No changes (POLICY-EWsf3)",
      }),
    ).toBe(true);
  });

  it("does not swallow unrelated API failures", () => {
    expect(isZitadelNoChangesResponse(405, { code: 12, message: "Method Not Allowed" })).toBe(false);
    expect(isZitadelNoChangesResponse(400, { code: 9, message: "Different precondition" })).toBe(false);
    expect(isZitadelNoChangesResponse(500, { code: 9, message: "No changes" })).toBe(false);
  });
});
