-- Stage 16 — mirror existing and future AppGroupDeployment rows into Operations.
-- AppGroupDeployment remains the execution engine of record.

INSERT INTO "Operation" (
  "id", "type", "tenantId", "resourceType", "resourceId", "status",
  "phase", "createdBy", "createdByEmail", "createdByDisplayName", "input",
  "result", "idempotencyKey", "attempt", "maxAttempts", "nextAttemptAt",
  "errorCode", "errorMessage", "createdAt", "startedAt", "completedAt"
)
SELECT
  deployment."id",
  CASE
    WHEN deployment."rollbackTargetVersion" IS NULL THEN 'APP_GROUP_DEPLOY'
    ELSE 'APP_GROUP_ROLLBACK'
  END,
  app_group."tenantId",
  'AppGroupDeployment',
  deployment."id",
  CASE deployment."status"::text
    WHEN 'Pending' THEN 'Pending'::"OperationStatus"
    WHEN 'Deploying' THEN 'Running'::"OperationStatus"
    WHEN 'Succeeded' THEN
      CASE
        WHEN deployment."rollbackTargetVersion" IS NULL
          THEN 'Succeeded'::"OperationStatus"
        ELSE 'RolledBack'::"OperationStatus"
      END
    WHEN 'Failed' THEN 'Failed'::"OperationStatus"
    WHEN 'RollingBack' THEN 'RollingBack'::"OperationStatus"
    WHEN 'RolledBack' THEN 'RolledBack'::"OperationStatus"
    WHEN 'RollbackFailed' THEN 'RollbackFailed'::"OperationStatus"
  END,
  deployment."phase"::text,
  deployment."createdBy",
  actor."email",
  actor."displayName",
  jsonb_build_object(
    'deploymentId', deployment."id",
    'appGroupId', deployment."appGroupId",
    'version', deployment."version",
    'rollbackTargetVersion', deployment."rollbackTargetVersion",
    'correlationId', deployment."correlationId"
  ),
  jsonb_build_object(
    'deploymentId', deployment."id",
    'version', deployment."version",
    'rollbackTargetVersion', deployment."rollbackTargetVersion",
    'deploymentStatus', deployment."status"::text
  ),
  'deployment:' || deployment."id"::text,
  0,
  1,
  deployment."createdAt",
  deployment."errorCode",
  deployment."errorMessage",
  deployment."createdAt",
  deployment."startedAt",
  deployment."completedAt"
FROM "AppGroupDeployment" AS deployment
JOIN "AppGroup" AS app_group ON app_group."id" = deployment."appGroupId"
JOIN "User" AS actor ON actor."id" = deployment."createdBy"
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "OperationEvent" (
  "id", "operationId", "timestamp", "phase", "level", "event", "message",
  "details"
)
SELECT
  deployment."id",
  deployment."id",
  deployment."createdAt",
  deployment."phase"::text,
  'Info',
  'OperationCreated',
  'Existing AppGroup deployment backfilled into Operations',
  jsonb_build_object(
    'deploymentId', deployment."id",
    'version', deployment."version"
  )
FROM "AppGroupDeployment" AS deployment
JOIN "Operation" AS operation
  ON operation."id" = deployment."id"
  AND operation."resourceType" = 'AppGroupDeployment'
ON CONFLICT ("id") DO NOTHING;

CREATE OR REPLACE FUNCTION "stage16_mirror_app_group_deployment"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  tenant_id UUID;
  actor_email TEXT;
  actor_display_name TEXT;
  operation_type TEXT;
BEGIN
  SELECT app_group."tenantId", actor."email", actor."displayName"
  INTO tenant_id, actor_email, actor_display_name
  FROM "AppGroup" AS app_group
  JOIN "User" AS actor ON actor."id" = NEW."createdBy"
  WHERE app_group."id" = NEW."appGroupId";

  operation_type := CASE
    WHEN NEW."rollbackTargetVersion" IS NULL THEN 'APP_GROUP_DEPLOY'
    ELSE 'APP_GROUP_ROLLBACK'
  END;

  INSERT INTO "Operation" (
    "id", "type", "tenantId", "resourceType", "resourceId", "status",
    "phase", "createdBy", "createdByEmail", "createdByDisplayName", "input",
    "idempotencyKey", "maxAttempts", "nextAttemptAt"
  ) VALUES (
    NEW."id",
    operation_type,
    tenant_id,
    'AppGroupDeployment',
    NEW."id",
    'Pending'::"OperationStatus",
    NEW."phase"::text,
    NEW."createdBy",
    actor_email,
    actor_display_name,
    jsonb_build_object(
      'deploymentId', NEW."id",
      'appGroupId', NEW."appGroupId",
      'version', NEW."version",
      'rollbackTargetVersion', NEW."rollbackTargetVersion",
      'correlationId', NEW."correlationId"
    ),
    'deployment:' || NEW."id"::text,
    1,
    NOW()
  )
  ON CONFLICT ("id") DO NOTHING;

  IF FOUND THEN
    INSERT INTO "OperationEvent" (
      "id", "operationId", "phase", "level", "event", "message", "details"
    ) VALUES (
      NEW."id",
      NEW."id",
      NEW."phase"::text,
      'Info',
      'OperationCreated',
      'AppGroup deployment mirrored into Operations',
      jsonb_build_object(
        'deploymentId', NEW."id",
        'version', NEW."version"
      )
    )
    ON CONFLICT ("id") DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "stage16_mirror_app_group_deployment_insert"
ON "AppGroupDeployment";

CREATE TRIGGER "stage16_mirror_app_group_deployment_insert"
AFTER INSERT ON "AppGroupDeployment"
FOR EACH ROW
EXECUTE FUNCTION "stage16_mirror_app_group_deployment"();
