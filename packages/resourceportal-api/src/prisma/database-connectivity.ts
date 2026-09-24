export function isTransientDatabaseConnectivityError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: unknown;
    errorCode?: unknown;
    message?: unknown;
  };
  if (candidate.code === "P1001" || candidate.errorCode === "P1001")
    return true;
  return (
    typeof candidate.message === "string" &&
    (candidate.message.includes("Can't reach database server") ||
      candidate.message.includes("P1001"))
  );
}

export async function connectWithTransientRetry(
  connect: () => Promise<void>,
  options: {
    attempts: number;
    delayMs: number;
    sleep?: (ms: number) => Promise<void>;
  },
) {
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt += 1) {
    try {
      await connect();
      return;
    } catch (error) {
      if (
        attempt >= options.attempts ||
        !isTransientDatabaseConnectivityError(error)
      ) {
        throw error;
      }
      await sleep(options.delayMs);
    }
  }
}
