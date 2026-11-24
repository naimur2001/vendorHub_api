-- CreateEnum
CREATE TYPE "ProductDeletionScope" AS ENUM ('PRODUCT', 'LISTING');

-- AlterEnum
ALTER TYPE "ProductDeletionOutcome" ADD VALUE 'LISTING_DELETED';

-- AlterTable
ALTER TABLE "ProductDeletionRequest" ADD COLUMN     "listingWasActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "scope" "ProductDeletionScope" NOT NULL DEFAULT 'PRODUCT';

-- CreateIndex
CREATE INDEX "ProductDeletionRequest_shopId_productId_idx" ON "ProductDeletionRequest"("shopId", "productId");


-- One PENDING request per product AND shop now (each shop can ask to leave a shared product).
DROP INDEX "ProductDeletionRequest_one_pending_per_product";
CREATE UNIQUE INDEX "ProductDeletionRequest_one_pending_per_shop_product" ON "ProductDeletionRequest"("productId", "shopId") WHERE "status" = 'PENDING';
