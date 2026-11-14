-- Markets by district: one key from the fixed list of the 64 districts (src/lib/districts.js).
-- The column is added empty, every existing market is set to "dhaka", then it becomes required.

-- AlterTable
ALTER TABLE "Market" ADD COLUMN     "district" TEXT;

UPDATE "Market" SET "district" = 'dhaka';

ALTER TABLE "Market" ALTER COLUMN "district" SET NOT NULL;

-- CreateIndex
CREATE INDEX "Market_district_idx" ON "Market"("district");
