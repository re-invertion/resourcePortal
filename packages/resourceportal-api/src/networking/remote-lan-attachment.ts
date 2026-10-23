/** A deliberately fail-closed contract for remote Ethernet attachments.
 * An attachment is *not* an L3 Site VPN route. The dataplane must implement
 * the authenticated isolated L2 channel before marking the lease active.
 */
export type RemoteLanAttachment = {
  tenantId: string;
  singleAppId: string;
  gateId: string;
  interfaceName: string;
  macAddress: string;
  status: "Pending" | "Provisioning" | "Active" | "Error" | "Revoking" | "Revoked";
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const mac = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;
export function validateRemoteLanAttachments(input: unknown): RemoteLanAttachment[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid remote LAN snapshot");
  const obj = input as { version?: unknown; attachments?: unknown };
  if (obj.version !== 1 || !Array.isArray(obj.attachments) || obj.attachments.length > 1024)
    throw new Error("Unsupported remote LAN snapshot");
  const seen = new Set<string>();
  return obj.attachments.map((raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("Invalid remote LAN attachment");
    const item = raw as RemoteLanAttachment;
    if (![item.tenantId, item.singleAppId, item.gateId].every(v => typeof v === "string" && uuid.test(v)) ||
        typeof item.interfaceName !== "string" || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,14}$/.test(item.interfaceName) ||
        typeof item.macAddress !== "string" || !mac.test(item.macAddress) ||
        !["Pending","Provisioning","Active","Error","Revoking","Revoked"].includes(item.status))
      throw new Error("Invalid remote LAN attachment identity");
    const octet = parseInt(item.macAddress.slice(0, 2), 16);
    if ((octet & 1) !== 0 || (octet & 2) === 0)
      throw new Error("Remote LAN attachment requires locally administered unicast MAC");
    const key = item.tenantId + ":" + item.singleAppId;
    if (seen.has(key)) throw new Error("Application may have only one remote LAN attachment");
    seen.add(key);
    return item;
  });
}
export function remoteLanAttachmentForWorkload(
  attachments: RemoteLanAttachment[], tenantId: string, appId: string, gateId: string,
): RemoteLanAttachment | undefined {
  return attachments.find(item => item.tenantId === tenantId &&
    item.singleAppId === appId && item.gateId === gateId && item.status === "Active");
}
