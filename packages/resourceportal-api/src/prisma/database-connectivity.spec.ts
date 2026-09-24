import { describe, expect, it, vi } from "vitest";
import {
  connectWithTransientRetry,
  isTransientDatabaseConnectivityError,
} from "./database-connectivity";

function prismaError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

describe("database connectivity retry", () => {
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
  it("retries transient connection failures and then succeeds", async () => {
    let calls = 0;
    const sleep = vi.fn(() => Promise.resolve());
    await connectWithTransientRetry(
      () => {
        calls += 1;
        return calls < 3
          ? Promise.reject(prismaError("P1001", "temporary"))
          : Promise.resolve();
      },
      { attempts: 4, delayMs: 10, sleep },
    );
    expect(calls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-transient failure", async () => {
    const sleep = vi.fn(() => Promise.resolve());
    await expect(
      connectWithTransientRetry(
        () => Promise.reject(prismaError("P2002", "logic failure")),
        { attempts: 4, delayMs: 10, sleep },
      ),
    ).rejects.toMatchObject({ code: "P2002" });
    expect(sleep).not.toHaveBeenCalled();
  });
});
