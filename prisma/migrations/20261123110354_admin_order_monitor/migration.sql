-- AlterTable
ALTER TABLE "OrderStatusEvent" ADD COLUMN     "actorId" TEXT;

-- AlterTable
ALTER TABLE "SubOrder" ADD COLUMN     "shopRemindedAt" TIMESTAMP(3),
ADD COLUMN     "statusAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "AdminOrderNote" (
    "id" TEXT NOT NULL,
    "subOrderId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminOrderNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminOrderNote_subOrderId_createdAt_idx" ON "AdminOrderNote"("subOrderId", "createdAt");

-- CreateIndex
CREATE INDEX "SubOrder_status_statusAt_idx" ON "SubOrder"("status", "statusAt");

-- CreateIndex
CREATE INDEX "SubOrder_createdAt_idx" ON "SubOrder"("createdAt");

-- AddForeignKey
ALTER TABLE "AdminOrderNote" ADD CONSTRAINT "AdminOrderNote_subOrderId_fkey" FOREIGN KEY ("subOrderId") REFERENCES "SubOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminOrderNote" ADD CONSTRAINT "AdminOrderNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Backfill: the current status was set at the latest timeline event (else the last update)
UPDATE "SubOrder" o
SET "statusAt" = COALESCE(
  (SELECT MAX(e."createdAt") FROM "OrderStatusEvent" e WHERE e."subOrderId" = o.id AND e.status = o.status),
  o."updatedAt");
