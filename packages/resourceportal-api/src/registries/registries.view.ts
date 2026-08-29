import { Registry } from "@prisma/client";

export function mapRegistry(registry: Registry) {
  return {
    id: registry.id,
    tenantId: registry.tenantId,
    name: registry.name,
    description: registry.description,
    host: registry.host,
    tlsMode: registry.tlsMode,
    authType: registry.authType,
    username: registry.username,
    hasCredential: registry.credentialData !== null,
    validationStatus: registry.validationStatus,
    lastValidatedAt: registry.lastValidatedAt,
    lastValidationError: registry.lastValidationError,
    createdBy: registry.createdBy,
    updatedBy: registry.updatedBy,
    createdAt: registry.createdAt,
    updatedAt: registry.updatedAt,
  };
}
