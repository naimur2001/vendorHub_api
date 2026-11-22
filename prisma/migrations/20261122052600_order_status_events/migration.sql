-- CreateTable
CREATE TABLE "OrderStatusEvent" (
    "id" TEXT NOT NULL,
    "subOrderId" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL,
    "note" TEXT,
    "actorRole" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderStatusEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderStatusEvent_subOrderId_createdAt_idx" ON "OrderStatusEvent"("subOrderId", "createdAt");

-- AddForeignKey
ALTER TABLE "OrderStatusEvent" ADD CONSTRAINT "OrderStatusEvent_subOrderId_fkey" FOREIGN KEY ("subOrderId") REFERENCES "SubOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: a PLACED event at createdAt for every existing order ...
INSERT INTO "OrderStatusEvent" ("id", "subOrderId", "status", "actorRole", "createdAt")
SELECT gen_random_uuid()::text, "id", 'PLACED', 'SYSTEM', "createdAt" FROM "SubOrder";

-- ... and one for the current status when it is not PLACED (completedAt for COMPLETED)
INSERT INTO "OrderStatusEvent" ("id", "subOrderId", "status", "actorRole", "createdAt")
SELECT gen_random_uuid()::text, "id", "status", 'SYSTEM',
       CASE WHEN "status" = 'COMPLETED' THEN COALESCE("completedAt", "updatedAt") ELSE "updatedAt" END
FROM "SubOrder" WHERE "status" <> 'PLACED';
