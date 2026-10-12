-- Branding is tenant-scoped. Store a small validated raster logo as a data URL.
ALTER TABLE "Tenant" ADD COLUMN "logoDataUrl" TEXT;
