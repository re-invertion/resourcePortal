ALTER TABLE "BugReport"
ADD COLUMN "resolvedAt" TIMESTAMP(3);

CREATE INDEX "BugReport_resolvedAt_createdAt_idx"
ON "BugReport"("resolvedAt", "createdAt");
