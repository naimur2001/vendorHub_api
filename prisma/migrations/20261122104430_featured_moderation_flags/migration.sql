-- CreateEnum
CREATE TYPE "ModerationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "FeaturedKind" AS ENUM ('SHOP', 'PRODUCT');

-- CreateEnum
CREATE TYPE "FlagTarget" AS ENUM ('REVIEW', 'ORDER_MESSAGE');

-- CreateEnum
CREATE TYPE "FlagReason" AS ENUM ('SPAM', 'ABUSE', 'SCAM', 'PERSONAL_INFO', 'OFF_TOPIC', 'OTHER');

-- CreateEnum
CREATE TYPE "FlagStatus" AS ENUM ('OPEN', 'HIDDEN', 'KEPT');

-- AlterTable
ALTER TABLE "OrderMessage" ADD COLUMN     "isHidden" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "moderatedAt" TIMESTAMP(3),
ADD COLUMN     "moderationNote" TEXT,
ADD COLUMN     "moderationStatus" "ModerationStatus" NOT NULL DEFAULT 'APPROVED';

-- AlterTable
ALTER TABLE "Review" ADD COLUMN     "isHidden" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "FeaturedSlot" (
    "id" TEXT NOT NULL,
    "kind" "FeaturedKind" NOT NULL,
    "targetId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeaturedSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentFlag" (
    "id" TEXT NOT NULL,
    "targetType" "FlagTarget" NOT NULL,
    "targetId" TEXT NOT NULL,
    "reporterId" TEXT,
    "reason" "FlagReason" NOT NULL,
    "note" TEXT,
    "auto" BOOLEAN NOT NULL DEFAULT false,
    "status" "FlagStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentFlag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FeaturedSlot_kind_sortOrder_idx" ON "FeaturedSlot"("kind", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "FeaturedSlot_kind_targetId_key" ON "FeaturedSlot"("kind", "targetId");

-- CreateIndex
CREATE INDEX "ContentFlag_status_createdAt_idx" ON "ContentFlag"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ContentFlag_targetType_targetId_idx" ON "ContentFlag"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "ContentFlag_reporterId_createdAt_idx" ON "ContentFlag"("reporterId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ContentFlag_targetType_targetId_reporterId_key" ON "ContentFlag"("targetType", "targetId", "reporterId");
