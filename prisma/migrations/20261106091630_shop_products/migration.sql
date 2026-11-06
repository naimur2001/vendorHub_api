-- CreateEnum
CREATE TYPE "ProductSource" AS ENUM ('ADMIN', 'SHOP');

-- AlterTable
ALTER TABLE "Image" ADD COLUMN     "productId" TEXT,
ADD COLUMN     "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "createdByShopId" TEXT,
ADD COLUMN     "reviewedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "reviewedById" TEXT,
ADD COLUMN     "source" "ProductSource" NOT NULL DEFAULT 'ADMIN';

-- CreateIndex
CREATE INDEX "Image_productId_sortOrder_idx" ON "Image"("productId", "sortOrder");

-- CreateIndex
CREATE INDEX "Product_source_reviewedAt_idx" ON "Product"("source", "reviewedAt");

-- CreateIndex
CREATE INDEX "Product_createdByShopId_createdAt_idx" ON "Product"("createdByShopId", "createdAt");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_createdByShopId_fkey" FOREIGN KEY ("createdByShopId") REFERENCES "Shop"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Image" ADD CONSTRAINT "Image_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
