export function isZitadelNoChangesResponse(status: number, payload: unknown) {
  if (status !== 400 || !payload || typeof payload !== "object") return false;
  const record = payload as Record<string, unknown>;
  return (
    record.code === 9 &&
    typeof record.message === "string" &&
    record.message.toLowerCase().startsWith("no changes")
  );
}
