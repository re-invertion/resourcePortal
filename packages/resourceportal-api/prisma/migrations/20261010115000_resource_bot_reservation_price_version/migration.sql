-- Older in-flight reservations have an unknown price version and must be
-- rejected by settlement rather than silently priced at a newer rate.
ALTER TABLE "ResourceBotUsageReservation" ADD COLUMN "priceVersionId" UUID;
ALTER TABLE "ResourceBotUsageReservation"
  ADD CONSTRAINT "ResourceBotUsageReservation_priceVersionId_fkey"
  FOREIGN KEY ("priceVersionId") REFERENCES "ResourceBotPriceVersion"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
