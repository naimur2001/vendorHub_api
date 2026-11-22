-- CreateEnum
CREATE TYPE "MessageSenderRole" AS ENUM ('CUSTOMER', 'SHOP');

-- CreateTable
CREATE TABLE "OrderMessage" (
    "id" TEXT NOT NULL,
    "subOrderId" TEXT NOT NULL,
    "senderRole" "MessageSenderRole" NOT NULL,
    "senderUserId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),

    CONSTRAINT "OrderMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderMessage_subOrderId_createdAt_idx" ON "OrderMessage"("subOrderId", "createdAt");

-- CreateIndex
CREATE INDEX "OrderMessage_subOrderId_senderRole_readAt_idx" ON "OrderMessage"("subOrderId", "senderRole", "readAt");

-- AddForeignKey
ALTER TABLE "OrderMessage" ADD CONSTRAINT "OrderMessage_subOrderId_fkey" FOREIGN KEY ("subOrderId") REFERENCES "SubOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
