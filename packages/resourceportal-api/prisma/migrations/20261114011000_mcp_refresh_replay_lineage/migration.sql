-- Retain hashed spent refresh tokens to detect replay and invalidate the
-- full successor grant, even when the current refresh hash has rotated.
-- Additive, cascade-bounded to its OAuth grant; no raw tokens are stored.
CREATE TABLE "McpOAuthSpentRefreshToken" (
  "tokenHash" TEXT NOT NULL,
  "grantId" UUID NOT NULL,
  "consumedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "McpOAuthSpentRefreshToken_pkey" PRIMARY KEY ("tokenHash"),
  CONSTRAINT "McpOAuthSpentRefreshToken_grantId_fkey"
    FOREIGN KEY ("grantId") REFERENCES "McpOAuthGrant"("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "McpOAuthSpentRefreshToken_grantId_idx"
  ON "McpOAuthSpentRefreshToken"("grantId");
