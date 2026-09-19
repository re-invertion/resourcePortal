-- v0.1.10: tenants may fund balances only by redeeming platform-issued vouchers.
-- Direct balance mutations are reserved for Platform Admin endpoints.

INSERT INTO "Permission" ("id")
VALUES ('billing.voucher.redeem')
ON CONFLICT ("id") DO NOTHING;

-- Retire the old self-service top-up permission from every role.
DELETE FROM "RolePermission"
WHERE "permissionId" = 'billing.topup';

UPDATE "Role"
SET "permissions" = array_remove("permissions", 'billing.topup')
WHERE 'billing.topup' = ANY("permissions");

-- Built-in tenant administrators and billing administrators may redeem vouchers.
INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT role_id, 'billing.voucher.redeem'
FROM (VALUES ('tenant-admin'), ('billing-admin')) AS roles(role_id)
WHERE EXISTS (SELECT 1 FROM "Role" WHERE "id" = role_id)
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

UPDATE "Role"
SET "permissions" = array_append("permissions", 'billing.voucher.redeem')
WHERE "id" IN ('tenant-admin', 'billing-admin')
  AND NOT ('billing.voucher.redeem' = ANY("permissions"));

DELETE FROM "Permission"
WHERE "id" = 'billing.topup'
  AND NOT EXISTS (
    SELECT 1 FROM "RolePermission"
    WHERE "permissionId" = 'billing.topup'
  );
