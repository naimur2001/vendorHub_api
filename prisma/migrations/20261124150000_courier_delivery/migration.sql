-- CreateEnum
CREATE TYPE "CourierCode" AS ENUM ('PATHAO', 'STEADFAST', 'REDX', 'PAPERFLY', 'ECOURIER');

-- CreateEnum
CREATE TYPE "ShopDeliveryMode" AS ENUM ('OWN', 'PLATFORM_COURIER');

-- CreateEnum
CREATE TYPE "DeliveryZoneCode" AS ENUM ('INSIDE_DHAKA', 'DHAKA_SUBURB', 'OUTSIDE_DHAKA');

-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('PENDING', 'BOOKED', 'PICKUP_ASSIGNED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED', 'RETURNING', 'RETURNED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Address" ADD COLUMN     "courierAreaId" INTEGER,
ADD COLUMN     "courierAreaName" TEXT,
ADD COLUMN     "courierCityId" INTEGER,
ADD COLUMN     "courierCityName" TEXT,
ADD COLUMN     "courierZoneId" INTEGER,
ADD COLUMN     "courierZoneName" TEXT;

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "courierStoreId" TEXT,
ADD COLUMN     "deliveryMode" "ShopDeliveryMode" NOT NULL DEFAULT 'OWN';

-- CreateTable
CREATE TABLE "CourierProvider" (
    "id" TEXT NOT NULL,
    "code" "CourierCode" NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "sandbox" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CourierProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryZone" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" "DeliveryZoneCode" NOT NULL,
    "customerFee" INTEGER NOT NULL,
    "etaText" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "courierCityIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "courierZoneIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryZone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shipment" (
    "id" TEXT NOT NULL,
    "subOrderId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "providerId" TEXT,
    "consignmentId" TEXT,
    "trackingCode" TEXT,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'PENDING',
    "statusAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "zoneCode" "DeliveryZoneCode" NOT NULL,
    "customerFee" INTEGER NOT NULL,
    "courierCost" INTEGER,
    "margin" INTEGER,
    "codAmount" INTEGER NOT NULL DEFAULT 0,
    "codCollected" BOOLEAN NOT NULL DEFAULT false,
    "codRemittedAt" TIMESTAMP(3),
    "shopPaidAt" TIMESTAMP(3),
    "bookedAt" TIMESTAMP(3),
    "pickedUpAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "failReason" TEXT,
    "recipient" JSONB NOT NULL,
    "bookingAttempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "bookingStartedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastEventAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShipmentEvent" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "status" "ShipmentStatus",
    "rawStatus" TEXT NOT NULL,
    "note" TEXT,
    "source" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "raw" JSONB,
    "at" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShipmentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CourierProvider_code_key" ON "CourierProvider"("code");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryZone_code_key" ON "DeliveryZone"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Shipment_subOrderId_key" ON "Shipment"("subOrderId");

-- CreateIndex
CREATE INDEX "Shipment_status_idx" ON "Shipment"("status");

-- CreateIndex
CREATE INDEX "Shipment_providerId_idx" ON "Shipment"("providerId");

-- CreateIndex
CREATE INDEX "Shipment_createdAt_idx" ON "Shipment"("createdAt");

-- CreateIndex
CREATE INDEX "Shipment_shopId_idx" ON "Shipment"("shopId");

-- CreateIndex
CREATE INDEX "Shipment_status_nextAttemptAt_idx" ON "Shipment"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "Shipment_providerId_consignmentId_key" ON "Shipment"("providerId", "consignmentId");

-- CreateIndex
CREATE UNIQUE INDEX "ShipmentEvent_dedupeKey_key" ON "ShipmentEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "ShipmentEvent_shipmentId_at_idx" ON "ShipmentEvent"("shipmentId", "at");

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_subOrderId_fkey" FOREIGN KEY ("subOrderId") REFERENCES "SubOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "CourierProvider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipmentEvent" ADD CONSTRAINT "ShipmentEvent_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Exactly one default courier (Prisma cannot express a partial index; a later "migrate diff" will
-- propose dropping it: remove that line from the generated SQL).
CREATE UNIQUE INDEX "CourierProvider_one_default" ON "CourierProvider"("isDefault") WHERE "isDefault" = true;

-- Seed data the app needs (also made by prisma/seed.js): the 5 couriers (only Pathao active and
-- default) and the 3 delivery zones (Pathao city 1 = Dhaka).
INSERT INTO "CourierProvider" ("id", "code", "name", "isActive", "isDefault", "sandbox", "config", "updatedAt") VALUES
  (gen_random_uuid()::text, 'PATHAO', 'Pathao', true, true, true, '{"deliveryType":48,"itemType":2,"itemWeight":0.5}', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'STEADFAST', 'Steadfast', false, false, true, NULL, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'REDX', 'RedX', false, false, true, NULL, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'PAPERFLY', 'Paperfly', false, false, true, NULL, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'ECOURIER', 'eCourier', false, false, true, NULL, CURRENT_TIMESTAMP);
INSERT INTO "DeliveryZone" ("id", "name", "code", "customerFee", "etaText", "isActive", "courierCityIds", "courierZoneIds", "updatedAt") VALUES
  (gen_random_uuid()::text, 'Inside Dhaka', 'INSIDE_DHAKA', 80, '1-2 days', true, ARRAY[1], ARRAY[]::INTEGER[], CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'Dhaka suburbs', 'DHAKA_SUBURB', 120, '2-3 days', true, ARRAY[]::INTEGER[], ARRAY[]::INTEGER[], CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'Outside Dhaka', 'OUTSIDE_DHAKA', 150, '3-5 days', true, ARRAY[]::INTEGER[], ARRAY[]::INTEGER[], CURRENT_TIMESTAMP);
