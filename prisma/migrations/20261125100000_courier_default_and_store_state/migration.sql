-- CreateEnum
CREATE TYPE "CourierStoreState" AS ENUM ('NONE', 'PENDING_APPROVAL', 'READY');

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "courierStoreLocation" JSONB,
ADD COLUMN     "courierStoreRequestedAt" TIMESTAMP(3),
ADD COLUMN     "courierStoreState" "CourierStoreState" NOT NULL DEFAULT 'NONE',
ALTER COLUMN "deliveryMode" SET DEFAULT 'PLATFORM_COURIER';

-- Backfill: every existing shop uses the platform courier (the shop's own delivery comes later);
-- a shop that already has a courier store is READY.
UPDATE "Shop" SET "deliveryMode" = 'PLATFORM_COURIER' WHERE "deliveryMode" <> 'PLATFORM_COURIER';
UPDATE "Shop" SET "courierStoreState" = 'READY' WHERE "courierStoreId" IS NOT NULL;
