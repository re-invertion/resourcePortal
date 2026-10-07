ALTER TYPE "BugReportPriority" ADD VALUE IF NOT EXISTS 'Unassigned';

ALTER TABLE "BugReport"
  ALTER COLUMN "priority" SET DEFAULT 'Unassigned';
