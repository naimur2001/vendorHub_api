-- AlterTable
ALTER TABLE "ShopListing" ADD COLUMN     "lowStockAt" INTEGER DEFAULT 3,
ADD COLUMN     "lowStockNotifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ListingView" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "visitorHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ListingView_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AddToCartEvent" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AddToCartEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ListingView_shopId_day_idx" ON "ListingView"("shopId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "ListingView_listingId_day_visitorHash_key" ON "ListingView"("listingId", "day", "visitorHash");

-- CreateIndex
CREATE INDEX "AddToCartEvent_shopId_day_idx" ON "AddToCartEvent"("shopId", "day");

-- AddForeignKey
ALTER TABLE "ListingView" ADD CONSTRAINT "ListingView_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "ShopListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AddToCartEvent" ADD CONSTRAINT "AddToCartEvent_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "ShopListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
