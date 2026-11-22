-- CreateEnum
CREATE TYPE "BannerMediaType" AS ENUM ('IMAGE', 'GIF', 'SVG', 'VIDEO');

-- CreateTable
CREATE TABLE "Banner" (
    "id" TEXT NOT NULL,
    "titleEn" TEXT NOT NULL,
    "titleBn" TEXT,
    "subtitleEn" TEXT,
    "subtitleBn" TEXT,
    "mediaType" "BannerMediaType" NOT NULL,
    "imageId" TEXT NOT NULL,
    "mobileImageId" TEXT,
    "linkUrl" TEXT,
    "ctaLabelEn" TEXT,
    "ctaLabelBn" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Banner_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Banner_imageId_key" ON "Banner"("imageId");

-- CreateIndex
CREATE UNIQUE INDEX "Banner_mobileImageId_key" ON "Banner"("mobileImageId");

-- CreateIndex
CREATE INDEX "Banner_isActive_sortOrder_idx" ON "Banner"("isActive", "sortOrder");

-- AddForeignKey
ALTER TABLE "Banner" ADD CONSTRAINT "Banner_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Banner" ADD CONSTRAINT "Banner_mobileImageId_fkey" FOREIGN KEY ("mobileImageId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;
