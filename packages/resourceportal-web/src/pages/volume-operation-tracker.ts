export type VolumeOperationState = {
  id: string;
  status: string;
  errorMessage?: string;
};

const TERMINAL = new Set(["Succeeded", "Failed", "RolledBack", "RollbackFailed"]);

export async function waitForVolumeOperation(
  tenantId: string,
  accepted: unknown,
  fetchOperation: (path: string) => Promise<unknown>,
  pause: () => Promise<void>,
  maxPolls = 30,
): Promise<VolumeOperationState> {
  if (!accepted || typeof accepted !== "object" || !("id" in accepted) ||
      typeof accepted.id !== "string" || !accepted.id) {
    throw new Error("Volume operation was accepted without an operation ID");
  }
  const id = accepted.id;
  const operationUrl = `/api/tenants/${encodeURIComponent(tenantId)}/operations/${encodeURIComponent(id)}`;
  let status = "Pending";
  let errorMessage: string | undefined;
  for (let poll = 0; poll < maxPolls; poll++) {
    if (poll > 0) await pause();
    const result = await fetchOperation(operationUrl);
    if (!result || typeof result !== "object" || !("status" in result) ||
        typeof result.status !== "string") {
      throw new Error("Unable to verify volume operation state");
    }
    status = result.status;
    errorMessage = "errorMessage" in result && typeof result.errorMessage === "string"
      ? result.errorMessage : undefined;
    if (TERMINAL.has(status)) break;
  }
  return { id, status, errorMessage };
}
