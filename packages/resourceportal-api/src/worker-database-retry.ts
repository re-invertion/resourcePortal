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
