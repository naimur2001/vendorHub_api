-- CreateEnum
CREATE TYPE "SubscriptionModule" AS ENUM ('ANALYTICS', 'CSV_IMPORT', 'PROMOTIONS', 'FEATURED_SLOTS', 'STAFF_ACCOUNTS', 'BARGAINING', 'ORDER_CHAT', 'COURIER_DELIVERY', 'SHOP_PHOTOS_EXTRA', 'PRIORITY_SUPPORT');

-- CreateEnum
CREATE TYPE "BillingPeriod" AS ENUM ('MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIAL', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED', 'FREE');

-- CreateEnum
CREATE TYPE "SubscriptionSource" AS ENUM ('ADMIN', 'SELF_SERVE');

-- CreateEnum
CREATE TYPE "SubscriptionPaymentMethod" AS ENUM ('MANUAL_BKASH', 'MANUAL_NAGAD', 'CASH', 'BANK', 'ONLINE');

-- CreateEnum
CREATE TYPE "SubscriptionPaymentStatus" AS ENUM ('RECORDED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "SubscriptionRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PlanDiscountType" AS ENUM ('PERCENT', 'AMOUNT');

-- CreateTable
CREATE TABLE "PlatformSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "SubscriptionPlan" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameBn" TEXT NOT NULL,
    "descriptionEn" TEXT,
    "descriptionBn" TEXT,
    "modules" "SubscriptionModule"[] DEFAULT ARRAY[]::"SubscriptionModule"[],
    "maxProducts" INTEGER,
    "maxStaff" INTEGER,
    "maxActiveDeals" INTEGER,
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanPrice" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "period" "BillingPeriod" NOT NULL,
    "amount" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopSubscription" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "period" "BillingPeriod" NOT NULL,
    "status" "SubscriptionStatus" NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "currentPeriodEnd" TIMESTAMP(3),
    "trialEndsAt" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "priceAtStart" INTEGER NOT NULL,
    "source" "SubscriptionSource" NOT NULL DEFAULT 'ADMIN',
    "note" TEXT,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "endedAt" TIMESTAMP(3),
    "expiryNoticeDays" INTEGER,
    "couponId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionPayment" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "method" "SubscriptionPaymentMethod" NOT NULL,
    "reference" TEXT,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "recordedById" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "status" "SubscriptionPaymentStatus" NOT NULL DEFAULT 'RECORDED',
    "refundedAt" TIMESTAMP(3),
    "refundedById" TEXT,
    "refundNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriptionPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionRequest" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "period" "BillingPeriod" NOT NULL,
    "status" "SubscriptionRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT NOT NULL,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "rejectNote" TEXT,
    "subscriptionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriptionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopPlanPrice" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "period" "BillingPeriod" NOT NULL,
    "amount" INTEGER NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopPlanPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanCoupon" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "type" "PlanDiscountType" NOT NULL,
    "value" INTEGER NOT NULL,
    "planId" TEXT,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "maxUses" INTEGER,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanCoupon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopReferral" (
    "id" TEXT NOT NULL,
    "referrerShopId" TEXT NOT NULL,
    "referredShopId" TEXT NOT NULL,
    "rewardedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopReferral_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionPlan_code_key" ON "SubscriptionPlan"("code");

-- CreateIndex
CREATE UNIQUE INDEX "PlanPrice_planId_period_key" ON "PlanPrice"("planId", "period");

-- CreateIndex
CREATE INDEX "ShopSubscription_shopId_isCurrent_idx" ON "ShopSubscription"("shopId", "isCurrent");

-- CreateIndex
CREATE INDEX "ShopSubscription_status_currentPeriodEnd_idx" ON "ShopSubscription"("status", "currentPeriodEnd");

-- CreateIndex
CREATE INDEX "SubscriptionPayment_subscriptionId_idx" ON "SubscriptionPayment"("subscriptionId");

-- CreateIndex
CREATE INDEX "SubscriptionPayment_paidAt_idx" ON "SubscriptionPayment"("paidAt");

-- CreateIndex
CREATE INDEX "SubscriptionRequest_status_createdAt_idx" ON "SubscriptionRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "SubscriptionRequest_shopId_idx" ON "SubscriptionRequest"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopPlanPrice_shopId_planId_period_key" ON "ShopPlanPrice"("shopId", "planId", "period");

-- CreateIndex
CREATE UNIQUE INDEX "PlanCoupon_code_key" ON "PlanCoupon"("code");

-- CreateIndex
CREATE UNIQUE INDEX "ShopReferral_referredShopId_key" ON "ShopReferral"("referredShopId");

-- CreateIndex
CREATE INDEX "ShopReferral_referrerShopId_idx" ON "ShopReferral"("referrerShopId");

-- AddForeignKey
ALTER TABLE "PlanPrice" ADD CONSTRAINT "PlanPrice_planId_fkey" FOREIGN KEY ("planId") REFERENCES "SubscriptionPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopSubscription" ADD CONSTRAINT "ShopSubscription_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopSubscription" ADD CONSTRAINT "ShopSubscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "SubscriptionPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "ShopSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionRequest" ADD CONSTRAINT "SubscriptionRequest_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionRequest" ADD CONSTRAINT "SubscriptionRequest_planId_fkey" FOREIGN KEY ("planId") REFERENCES "SubscriptionPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopPlanPrice" ADD CONSTRAINT "ShopPlanPrice_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopPlanPrice" ADD CONSTRAINT "ShopPlanPrice_planId_fkey" FOREIGN KEY ("planId") REFERENCES "SubscriptionPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanCoupon" ADD CONSTRAINT "PlanCoupon_planId_fkey" FOREIGN KEY ("planId") REFERENCES "SubscriptionPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- At most one current subscription per shop, one pending plan request per shop (kept only here)
CREATE UNIQUE INDEX "ShopSubscription_one_current_per_shop" ON "ShopSubscription" ("shopId") WHERE "isCurrent";
CREATE UNIQUE INDEX "SubscriptionRequest_one_pending_per_shop" ON "SubscriptionRequest" ("shopId") WHERE "status" = 'PENDING';

-- The FREE plan (every module, no limits, 0 taka) keeps today's behaviour; shops without a row use it
INSERT INTO "SubscriptionPlan" ("id", "code", "nameEn", "nameBn", "descriptionEn", "descriptionBn", "modules", "isPublished", "isActive", "sortOrder", "updatedAt")
VALUES (gen_random_uuid()::text, 'FREE', 'Free', 'ফ্রি', 'Everything, free for now.', 'এখন সবকিছু ফ্রি।',
  ARRAY['ANALYTICS','CSV_IMPORT','PROMOTIONS','FEATURED_SLOTS','STAFF_ACCOUNTS','BARGAINING','ORDER_CHAT','COURIER_DELIVERY','SHOP_PHOTOS_EXTRA','PRIORITY_SUPPORT']::"SubscriptionModule"[],
  true, true, 0, CURRENT_TIMESTAMP);
INSERT INTO "PlanPrice" ("id", "planId", "period", "amount", "isActive", "updatedAt")
SELECT gen_random_uuid()::text, p.id, 'MONTHLY', 0, true, CURRENT_TIMESTAMP FROM "SubscriptionPlan" p WHERE p.code = 'FREE';
