import { describe, expect, it } from "vitest";
import { isTransientDatabaseConnectivityError } from "./worker-database-retry";

describe("isTransientDatabaseConnectivityError", () => {
  it("recognizes Prisma P1001 by code and errorCode", () => {
    expect(isTransientDatabaseConnectivityError({ code: "P1001" })).toBe(true);
    expect(isTransientDatabaseConnectivityError({ errorCode: "P1001" })).toBe(
      true,
    );
  });

  it("recognizes the Prisma database-unreachable message", () => {
    expect(
      isTransientDatabaseConnectivityError({
        message: "Can't reach database server at `postgres-rp:5432`",
      }),
    ).toBe(true);
  });

  it("does not hide non-transient worker failures", () => {
    expect(isTransientDatabaseConnectivityError({ code: "P2002" })).toBe(false);
    expect(
      isTransientDatabaseConnectivityError(new Error("logic failure")),
    ).toBe(false);
    expect(isTransientDatabaseConnectivityError("P1001")).toBe(false);
  });
});
