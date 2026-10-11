/**
 * Generic flags are untyped until routed to their destination DTO. Keys that
 * represent text must never be interpreted as numbers/booleans (leading zeros,
 * literal 'false', etc.). All other legacy numeric/boolean flags retain their
 * historical coercion for CLI backward compatibility.
 */
const TEXT_FIELDS = new Set([
  "name", "displayName", "description", "value", "content", "fileName",
  "clientId", "clientSecret", "username", "credential", "contactEmail",
  "code", "token", "issuer", "metadataUrl", "hostname", "host",
  "rootDomain", "prefix", "subdomain", "targetName", "targetPath",
  "mountPath", "containerUser", "workingDir", "entrypoint", "image",
  "idempotencyKey", "correlationId", "requestId", "note", "tenantId",
  "membershipId", "secretId", "configId", "registryId",
]);

export function coerceCliFlag(key: string, value: string): string | number | boolean {
  if (TEXT_FIELDS.has(key)) return value;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}
