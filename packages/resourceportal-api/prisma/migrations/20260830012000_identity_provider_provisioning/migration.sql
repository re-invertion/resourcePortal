ALTER TABLE "IdentityProvider"
ADD COLUMN "clientId" TEXT,
ADD COLUMN "clientSecretCiphertext" TEXT,
ADD COLUMN "scopes" TEXT[] NOT NULL DEFAULT ARRAY['openid', 'profile', 'email']::TEXT[],
ADD COLUMN "usePkce" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "provisionedAt" TIMESTAMP(3);
