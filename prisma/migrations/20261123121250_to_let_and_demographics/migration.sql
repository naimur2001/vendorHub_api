-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('FEMALE', 'MALE', 'OTHER', 'PREFER_NOT_TO_SAY');

-- CreateEnum
CREATE TYPE "ToLetStatus" AS ENUM ('PENDING_EMAIL', 'SUBMITTED', 'NEEDS_INFO', 'PUBLISHED', 'RENTED', 'REJECTED', 'EXPIRED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "ToLetThreadKind" AS ENUM ('OWNER', 'INQUIRY');

-- CreateEnum
CREATE TYPE "ToLetSenderRole" AS ENUM ('OWNER', 'RENTER', 'ADMIN');

-- CreateEnum
CREATE TYPE "ToLetInquiryStatus" AS ENUM ('NEW', 'IN_TALKS', 'CONNECTED', 'CLOSED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "birthYear" INTEGER,
ADD COLUMN     "gender" "Gender";

-- CreateTable
CREATE TABLE "ToLetListing" (
    "id" TEXT NOT NULL,
    "slug" TEXT,
    "submitterId" TEXT,
    "contactName" TEXT NOT NULL,
    "contactPhone" TEXT NOT NULL,
    "contactEmail" TEXT NOT NULL,
    "marketId" TEXT,
    "marketName" TEXT,
    "levelFloor" TEXT,
    "shopNumber" TEXT,
    "addressLine" TEXT NOT NULL,
    "sizeSqft" INTEGER NOT NULL,
    "monthlyRent" INTEGER NOT NULL,
    "advance" INTEGER NOT NULL,
    "availableFrom" TIMESTAMP(3) NOT NULL,
    "suitableFor" TEXT[],
    "description" TEXT NOT NULL,
    "status" "ToLetStatus" NOT NULL DEFAULT 'PENDING_EMAIL',
    "rejectReason" TEXT,
    "publishedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "expiryRemindedAt" TIMESTAMP(3),
    "emailTokenHash" TEXT,
    "emailTokenExpiresAt" TIMESTAMP(3),
    "manageTokenHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ToLetListing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToLetPhoto" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "imageId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ToLetPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToLetDocument" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "storedName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "originalName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ToLetDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToLetThread" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "kind" "ToLetThreadKind" NOT NULL,
    "inquiryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ToLetThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToLetMessage" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "senderRole" "ToLetSenderRole" NOT NULL,
    "senderUserId" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),

    CONSTRAINT "ToLetMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToLetInquiry" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "message" TEXT NOT NULL,
    "status" "ToLetInquiryStatus" NOT NULL DEFAULT 'NEW',
    "followTokenHash" TEXT,
    "contactsSharedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ToLetInquiry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToLetNote" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ToLetNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ToLetListing_slug_key" ON "ToLetListing"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "ToLetListing_emailTokenHash_key" ON "ToLetListing"("emailTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "ToLetListing_manageTokenHash_key" ON "ToLetListing"("manageTokenHash");

-- CreateIndex
CREATE INDEX "ToLetListing_status_publishedAt_idx" ON "ToLetListing"("status", "publishedAt");

-- CreateIndex
CREATE INDEX "ToLetListing_status_expiresAt_idx" ON "ToLetListing"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "ToLetListing_contactPhone_idx" ON "ToLetListing"("contactPhone");

-- CreateIndex
CREATE INDEX "ToLetListing_contactEmail_idx" ON "ToLetListing"("contactEmail");

-- CreateIndex
CREATE INDEX "ToLetListing_submitterId_idx" ON "ToLetListing"("submitterId");

-- CreateIndex
CREATE UNIQUE INDEX "ToLetPhoto_imageId_key" ON "ToLetPhoto"("imageId");

-- CreateIndex
CREATE INDEX "ToLetPhoto_listingId_sortOrder_idx" ON "ToLetPhoto"("listingId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "ToLetDocument_storedName_key" ON "ToLetDocument"("storedName");

-- CreateIndex
CREATE INDEX "ToLetDocument_listingId_idx" ON "ToLetDocument"("listingId");

-- CreateIndex
CREATE UNIQUE INDEX "ToLetThread_inquiryId_key" ON "ToLetThread"("inquiryId");

-- CreateIndex
CREATE INDEX "ToLetThread_listingId_kind_idx" ON "ToLetThread"("listingId", "kind");

-- CreateIndex
CREATE INDEX "ToLetMessage_threadId_createdAt_idx" ON "ToLetMessage"("threadId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ToLetInquiry_followTokenHash_key" ON "ToLetInquiry"("followTokenHash");

-- CreateIndex
CREATE INDEX "ToLetInquiry_listingId_phone_status_idx" ON "ToLetInquiry"("listingId", "phone", "status");

-- CreateIndex
CREATE INDEX "ToLetInquiry_phone_createdAt_idx" ON "ToLetInquiry"("phone", "createdAt");

-- CreateIndex
CREATE INDEX "ToLetNote_listingId_createdAt_idx" ON "ToLetNote"("listingId", "createdAt");

-- AddForeignKey
ALTER TABLE "ToLetListing" ADD CONSTRAINT "ToLetListing_submitterId_fkey" FOREIGN KEY ("submitterId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToLetListing" ADD CONSTRAINT "ToLetListing_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToLetPhoto" ADD CONSTRAINT "ToLetPhoto_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "ToLetListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToLetPhoto" ADD CONSTRAINT "ToLetPhoto_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToLetDocument" ADD CONSTRAINT "ToLetDocument_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "ToLetListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToLetThread" ADD CONSTRAINT "ToLetThread_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "ToLetListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToLetThread" ADD CONSTRAINT "ToLetThread_inquiryId_fkey" FOREIGN KEY ("inquiryId") REFERENCES "ToLetInquiry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToLetMessage" ADD CONSTRAINT "ToLetMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ToLetThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToLetInquiry" ADD CONSTRAINT "ToLetInquiry_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "ToLetListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToLetInquiry" ADD CONSTRAINT "ToLetInquiry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToLetNote" ADD CONSTRAINT "ToLetNote_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "ToLetListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToLetNote" ADD CONSTRAINT "ToLetNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

