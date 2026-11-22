-- CreateEnum
CREATE TYPE "BannerPlacement" AS ENUM ('HERO', 'SIDE_AD');

-- AlterTable
ALTER TABLE "Banner" ADD COLUMN     "placement" "BannerPlacement" NOT NULL DEFAULT 'HERO';

-- CreateIndex
CREATE INDEX "Banner_placement_isActive_sortOrder_idx" ON "Banner"("placement", "isActive", "sortOrder");
