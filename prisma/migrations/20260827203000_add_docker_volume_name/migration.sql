ALTER TABLE "Volume" ADD COLUMN "dockerVolumeName" TEXT;

UPDATE "Volume"
SET "dockerVolumeName" = 'rp_vol_' || replace("id"::text, '-', '_')
WHERE "dockerVolumeName" IS NULL;

ALTER TABLE "Volume" ALTER COLUMN "dockerVolumeName" SET NOT NULL;

CREATE UNIQUE INDEX "Volume_dockerVolumeName_key" ON "Volume"("dockerVolumeName");
