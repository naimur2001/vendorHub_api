-- CreateEnum
CREATE TYPE "ProductDeletionStatus" AS ENUM ('PENDING', 'REJECTED', 'CANCELLED', 'DONE');

-- CreateEnum
CREATE TYPE "ProductDeletionOutcome" AS ENUM ('DELETED', 'DEACTIVATED');

-- CreateTable
CREATE TABLE "ProductDeletionRequest" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "productWasActive" BOOLEAN NOT NULL,
    "shopId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "reason" TEXT,
    "status" "ProductDeletionStatus" NOT NULL DEFAULT 'PENDING',
    "outcome" "ProductDeletionOutcome",
    "autoDeleteAt" TIMESTAMP(3) NOT NULL,
    "rejectNote" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductDeletionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductDeletionRequest_status_autoDeleteAt_idx" ON "ProductDeletionRequest"("status", "autoDeleteAt");

-- CreateIndex
CREATE INDEX "ProductDeletionRequest_shopId_createdAt_idx" ON "ProductDeletionRequest"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "ProductDeletionRequest_productId_idx" ON "ProductDeletionRequest"("productId");

-- AddForeignKey
ALTER TABLE "ProductDeletionRequest" ADD CONSTRAINT "ProductDeletionRequest_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- At most one PENDING request per product (partial unique index; Prisma cannot express it, so a
-- later "migrate diff" will propose dropping it: remove that line from the generated SQL).
CREATE UNIQUE INDEX "ProductDeletionRequest_one_pending_per_product" ON "ProductDeletionRequest"("productId") WHERE "status" = 'PENDING';
