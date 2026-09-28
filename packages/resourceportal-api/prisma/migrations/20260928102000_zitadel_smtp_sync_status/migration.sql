ALTER TABLE "PlatformEmailSettings"
ADD COLUMN "zitadelProviderId" TEXT,
ADD COLUMN "lastZitadelSyncAt" TIMESTAMP(3),
ADD COLUMN "lastZitadelSyncError" TEXT;
