-- CreateEnum
CREATE TYPE "ProfitRuleType" AS ENUM ('FIXED', 'PERCENT');

-- CreateEnum
CREATE TYPE "ProfitRuleBase" AS ENUM ('CUSTOMER_FEE', 'COURIER_COST');

-- CreateTable
CREATE TABLE "DeliveryProfitRule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "ProfitRuleType" NOT NULL,
    "value" DECIMAL(8,2) NOT NULL,
    "percentOf" "ProfitRuleBase",
    "zoneId" TEXT,
    "providerId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryProfitRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeliveryProfitRule_zoneId_idx" ON "DeliveryProfitRule"("zoneId");

-- CreateIndex
CREATE INDEX "DeliveryProfitRule_providerId_idx" ON "DeliveryProfitRule"("providerId");

-- AddForeignKey
ALTER TABLE "DeliveryProfitRule" ADD CONSTRAINT "DeliveryProfitRule_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "DeliveryZone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryProfitRule" ADD CONSTRAINT "DeliveryProfitRule_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "CourierProvider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- At most one ACTIVE rule per scope (null zone / courier = all); kept only here (Prisma cannot express it)
CREATE UNIQUE INDEX "DeliveryProfitRule_one_active_per_scope" ON "DeliveryProfitRule" (COALESCE("zoneId", ''), COALESCE("providerId", '')) WHERE "isActive";
