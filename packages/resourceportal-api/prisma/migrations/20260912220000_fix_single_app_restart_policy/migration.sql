UPDATE "SingleApp"
SET "restartPolicy" = '{"condition":"any","delaySeconds":5}'::jsonb
WHERE "restartPolicy" = '{"condition":"on-failure","delaySeconds":5,"maxAttempts":3,"windowSeconds":60}'::jsonb;
