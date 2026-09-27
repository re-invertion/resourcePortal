CREATE TABLE "PlatformEmailSettings" (
    "id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "host" TEXT,
    "port" INTEGER NOT NULL DEFAULT 587,
    "mode" TEXT NOT NULL DEFAULT 'STARTTLS',
    "username" TEXT,
    "passwordCiphertext" TEXT,
    "fromEmail" TEXT,
    "fromName" TEXT,
    "replyTo" TEXT,
    "lastValidatedAt" TIMESTAMP(3),
    "lastTestSentAt" TIMESTAMP(3),
    "lastError" TEXT,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformEmailSettings_pkey" PRIMARY KEY ("id")
);
