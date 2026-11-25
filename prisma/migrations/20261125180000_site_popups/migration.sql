-- CreateEnum
CREATE TYPE "PopupAudience" AS ENUM ('ALL', 'GUESTS', 'CUSTOMERS', 'SHOP_TEAM');

-- CreateEnum
CREATE TYPE "PopupPages" AS ENUM ('HOME_ONLY', 'ALL_PAGES');

-- CreateEnum
CREATE TYPE "PopupFrequency" AS ENUM ('ONCE_PER_VISITOR', 'ONCE_PER_DAY', 'EVERY_VISIT');

-- CreateTable
CREATE TABLE "SitePopup" (
    "id" TEXT NOT NULL,
    "titleEn" TEXT NOT NULL,
    "titleBn" TEXT,
    "bodyEn" TEXT,
    "bodyBn" TEXT,
    "mediaType" "BannerMediaType" NOT NULL,
    "imageId" TEXT NOT NULL,
    "mobileImageId" TEXT,
    "linkUrl" TEXT,
    "ctaLabelEn" TEXT,
    "ctaLabelBn" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "priority" INTEGER NOT NULL DEFAULT 0,
    "audience" "PopupAudience" NOT NULL DEFAULT 'ALL',
    "pages" "PopupPages" NOT NULL DEFAULT 'HOME_ONLY',
    "frequency" "PopupFrequency" NOT NULL DEFAULT 'ONCE_PER_DAY',
    "delaySeconds" INTEGER NOT NULL DEFAULT 2,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SitePopup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SitePopupDailyStat" (
    "popupId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,
    "closes" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SitePopupDailyStat_pkey" PRIMARY KEY ("popupId","day")
);

-- CreateIndex
CREATE UNIQUE INDEX "SitePopup_imageId_key" ON "SitePopup"("imageId");

-- CreateIndex
CREATE UNIQUE INDEX "SitePopup_mobileImageId_key" ON "SitePopup"("mobileImageId");

-- CreateIndex
CREATE INDEX "SitePopup_isActive_priority_idx" ON "SitePopup"("isActive", "priority");

-- AddForeignKey
ALTER TABLE "SitePopup" ADD CONSTRAINT "SitePopup_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SitePopup" ADD CONSTRAINT "SitePopup_mobileImageId_fkey" FOREIGN KEY ("mobileImageId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SitePopupDailyStat" ADD CONSTRAINT "SitePopupDailyStat_popupId_fkey" FOREIGN KEY ("popupId") REFERENCES "SitePopup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

