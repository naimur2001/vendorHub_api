-- Product variations (size / colour) on shop listings; the choice travels with cart and order items.

-- DropIndex
DROP INDEX "CartItem_cartId_listingId_key";

-- AlterTable
ALTER TABLE "CartItem" ADD COLUMN     "options" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "optionsKey" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "options" JSONB;

-- AlterTable
ALTER TABLE "ShopListing" ADD COLUMN     "options" JSONB;

-- CreateIndex
CREATE UNIQUE INDEX "CartItem_cartId_listingId_optionsKey_key" ON "CartItem"("cartId", "listingId", "optionsKey");
