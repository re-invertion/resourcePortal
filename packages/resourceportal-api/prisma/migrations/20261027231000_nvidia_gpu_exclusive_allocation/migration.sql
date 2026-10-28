-- Durable, global NVIDIA device identity and assignment. This migration is
-- schema-changing and MUST NOT ship until database-restore rollback is certified.
CREATE TABLE "GpuDevice" (
    "uuid" VARCHAR(64) NOT NULL,
    "remoteLocationId" UUID,
    "vendor" TEXT NOT NULL DEFAULT 'NVIDIA',
    "model" TEXT NOT NULL,
    "pciBusId" TEXT NOT NULL,
    "memoryBytes" BIGINT NOT NULL,
    "memoryUsedBytes" BIGINT,
    "driverVersion" TEXT NOT NULL,
    "cudaVersion" TEXT,
    "temperatureCelsius" INTEGER,
    "utilizationPercent" INTEGER,
    "observedState" TEXT NOT NULL DEFAULT 'Unavailable',
    "lastObservedAt" TIMESTAMP(3),
    "allocatedSingleAppId" UUID,
    "allocationState" TEXT NOT NULL DEFAULT 'Free',
    "allocatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GpuDevice_pkey" PRIMARY KEY ("uuid"),
    CONSTRAINT "GpuDevice_allocation_state_check" CHECK (
       ("allocatedSingleAppId" IS NULL AND "allocationState" = 'Free' AND "allocatedAt" IS NULL)
       OR ("allocatedSingleAppId" IS NOT NULL AND "allocationState" IN ('Allocated','Releasing') AND "allocatedAt" IS NOT NULL)
    ),
    CONSTRAINT "GpuDevice_observed_state_check" CHECK ("observedState" IN ('Available','Unavailable','Unsupported')),
    CONSTRAINT "GpuDevice_memory_check" CHECK ("memoryBytes" > 0 AND ("memoryUsedBytes" IS NULL OR ("memoryUsedBytes" >= 0 AND "memoryUsedBytes" <= "memoryBytes")))
);
CREATE UNIQUE INDEX "GpuDevice_allocatedSingleAppId_key" ON "GpuDevice"("allocatedSingleAppId");
CREATE INDEX "GpuDevice_remoteLocationId_observedState_idx" ON "GpuDevice"("remoteLocationId", "observedState");
CREATE INDEX "GpuDevice_allocatedSingleAppId_allocationState_idx" ON "GpuDevice"("allocatedSingleAppId", "allocationState");
ALTER TABLE "GpuDevice" ADD CONSTRAINT "GpuDevice_remoteLocationId_fkey" FOREIGN KEY ("remoteLocationId") REFERENCES "RemoteLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GpuDevice" ADD CONSTRAINT "GpuDevice_allocatedSingleAppId_fkey" FOREIGN KEY ("allocatedSingleAppId") REFERENCES "SingleApp"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
