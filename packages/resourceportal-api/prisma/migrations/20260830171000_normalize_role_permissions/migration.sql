-- Stage 2: normalize role permissions into first-class Permission entities.
CREATE TABLE "Permission" (
    "id" TEXT NOT NULL,
    CONSTRAINT "Permission_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RolePermission" (
    "roleId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,
    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("roleId", "permissionId")
);

CREATE INDEX "RolePermission_permissionId_idx" ON "RolePermission"("permissionId");

-- Preserve every existing permission identifier, including the tenant-owner wildcard.
INSERT INTO "Permission" ("id")
SELECT DISTINCT permission_id
FROM "Role" AS role
CROSS JOIN LATERAL unnest(role."permissions") AS permission_id
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT role."id", permission_id
FROM "Role" AS role
CROSS JOIN LATERAL unnest(role."permissions") AS permission_id
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

ALTER TABLE "RolePermission"
ADD CONSTRAINT "RolePermission_roleId_fkey"
FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RolePermission"
ADD CONSTRAINT "RolePermission_permissionId_fkey"
FOREIGN KEY ("permissionId") REFERENCES "Permission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Role" DROP COLUMN "permissions";
