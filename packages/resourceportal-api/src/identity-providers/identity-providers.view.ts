import { IdentityProvider } from "@prisma/client";

export function mapIdentityProvider(provider: IdentityProvider) {
  const { clientSecretCiphertext, ...safeProvider } = provider;

  return {
    ...safeProvider,
    clientSecretConfigured: Boolean(clientSecretCiphertext),
  };
}
