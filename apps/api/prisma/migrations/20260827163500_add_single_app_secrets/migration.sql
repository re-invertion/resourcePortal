CREATE TABLE "SingleAppSecret" (
    "id" UUID NOT NULL,
    "singleAppId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "valueCiphertext" TEXT NOT NULL,
    "valueVersion" INTEGER NOT NULL DEFAULT 1,
    "createdBy" UUID NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SingleAppSecret_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SingleAppSecret_singleAppId_name_key" ON "SingleAppSecret"("singleAppId", "name");

ALTER TABLE "SingleAppSecret" ADD CONSTRAINT "SingleAppSecret_singleAppId_fkey" FOREIGN KEY ("singleAppId") REFERENCES "SingleApp"("id") ON DELETE CASCADE ON UPDATE CASCADE;
