CREATE TYPE "BugReportPriority" AS ENUM ('P0', 'P1', 'P2', 'P3');

CREATE TABLE "BugReport" (
    "id" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "priority" "BugReportPriority" NOT NULL DEFAULT 'P2',
    "reportedById" UUID NOT NULL,
    "imageData" BYTEA,
    "imageMimeType" VARCHAR(64),
    "imageFileName" VARCHAR(255),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BugReport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BugReport_priority_createdAt_idx" ON "BugReport"("priority", "createdAt");
CREATE INDEX "BugReport_reportedById_createdAt_idx" ON "BugReport"("reportedById", "createdAt");
ALTER TABLE "BugReport" ADD CONSTRAINT "BugReport_reportedById_fkey" FOREIGN KEY ("reportedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
