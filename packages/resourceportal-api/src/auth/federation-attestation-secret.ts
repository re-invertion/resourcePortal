import { createHmac } from "node:crypto";

/**
 * Distinct key scope from the existing at-rest encryption key. The derived
 * value may be stored in a Zitadel Action; the master key never is.
 * Changes to the master key require a matching Action reconciliation.
 */
export function deriveFederationAttestationSecret(master: Uint8Array | string): string {
  if (master.length < 32) {
    throw new Error("ResourcePortal master encryption key is too short");
  }
  return createHmac("sha256", master)
    .update("resourceportal:zitadel-external-idp-attestation:v1")
    .digest("hex");
}
