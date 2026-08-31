-- Stage 13: platform infrastructure inventory for the single Docker Swarm cluster.

CREATE TABLE "SwarmCluster" (
  "id" UUID NOT NULL,
  "dockerClusterId" TEXT NOT NULL,
  "health" TEXT NOT NULL DEFAULT 'Unknown',
  "managerCount" INTEGER NOT NULL DEFAULT 0,
  "nodeCount" INTEGER NOT NULL DEFAULT 0,
  "lastSyncedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SwarmCluster_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SwarmCluster_singleton_check"
    CHECK ("id" = '00000000-0000-0000-0000-000000000013'::uuid),
  CONSTRAINT "SwarmCluster_health_check"
    CHECK ("health" IN ('Healthy', 'Degraded', 'Unhealthy', 'Unknown'))
);

CREATE UNIQUE INDEX "SwarmCluster_dockerClusterId_key"
  ON "SwarmCluster"("dockerClusterId");

CREATE TABLE "RemoteLocation" (
  "id" UUID NOT NULL,
  "swarmNodeId" TEXT NOT NULL,
  "hostname" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "availability" TEXT NOT NULL,
  "health" TEXT NOT NULL DEFAULT 'Unknown',
  "maintenance" BOOLEAN NOT NULL DEFAULT false,
  "cpuNano" BIGINT NOT NULL DEFAULT 0,
  "availableCpuNano" BIGINT NOT NULL DEFAULT 0,
  "memoryBytes" BIGINT NOT NULL DEFAULT 0,
  "availableMemoryBytes" BIGINT NOT NULL DEFAULT 0,
  "gpuCount" INTEGER NOT NULL DEFAULT 0,
  "networkCapabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "lastSeenAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RemoteLocation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RemoteLocation_role_check"
    CHECK ("role" IN ('Manager', 'Worker')),
  CONSTRAINT "RemoteLocation_status_check"
    CHECK ("status" IN ('Ready', 'Down', 'Unknown', 'Disconnected', 'Removed')),
  CONSTRAINT "RemoteLocation_availability_check"
    CHECK ("availability" IN ('Active', 'Pause', 'Drain')),
  CONSTRAINT "RemoteLocation_health_check"
    CHECK ("health" IN ('Healthy', 'Degraded', 'Unhealthy', 'Unknown')),
  CONSTRAINT "RemoteLocation_capacity_check"
    CHECK (
      "cpuNano" >= 0 AND
      "availableCpuNano" >= 0 AND
      "availableCpuNano" <= "cpuNano" AND
      "memoryBytes" >= 0 AND
      "availableMemoryBytes" >= 0 AND
      "availableMemoryBytes" <= "memoryBytes" AND
      "gpuCount" >= 0
    )
);

CREATE UNIQUE INDEX "RemoteLocation_swarmNodeId_key"
  ON "RemoteLocation"("swarmNodeId");
CREATE INDEX "RemoteLocation_hostname_idx"
  ON "RemoteLocation"("hostname");
CREATE INDEX "RemoteLocation_status_health_idx"
  ON "RemoteLocation"("status", "health");
