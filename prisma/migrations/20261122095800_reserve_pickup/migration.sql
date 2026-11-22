-- AlterEnum
ALTER TYPE "DeliveryMethod" ADD VALUE 'RESERVE_PICKUP';

-- AlterTable
ALTER TABLE "SubOrder" ADD COLUMN     "reservedUntil" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "SubOrder_deliveryMethod_status_reservedUntil_idx" ON "SubOrder"("deliveryMethod", "status", "reservedUntil");
