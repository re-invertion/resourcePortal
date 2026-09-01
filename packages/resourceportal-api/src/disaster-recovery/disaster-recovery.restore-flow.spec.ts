import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Stage 19 disaster recovery restore flow", () => {
  it("runs migrations and post-restore reconciliation automatically", () => {
    const script = readFileSync(
      resolve(__dirname, "../../../../scripts/restore-control-plane.sh"),
      "utf8",
    );

    expect(script).toContain(
      "npm exec --workspace @resource-portal/api -- prisma migrate deploy",
    );
    expect(script).toContain(
      "npm --workspace @resource-portal/api run dr:reconcile",
    );
    expect(script).not.toContain(
      "Run database migrations and readiness checks before returning traffic.",
    );
  });
});
