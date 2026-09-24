export function isZitadelNoChangesResponse(status: number, payload: unknown) {
  if (status !== 400 || !payload || typeof payload !== "object") return false;
  const record = payload as Record<string, unknown>;
  const failedPrecondition =
    record.code === 9 ||
    (typeof record.code === "string" && record.code.toLowerCase() === "failed_precondition");
  return (
    failedPrecondition &&
    typeof record.message === "string" &&
    record.message.toLowerCase().startsWith("no changes")
  );
}
