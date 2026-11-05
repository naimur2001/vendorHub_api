/*
  Warnings:

  - A unique constraint covering the columns `[imageId]` on the table `Market` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Market" ADD COLUMN     "imageId" TEXT;

-- CreateTable
CREATE TABLE "Image" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "purpose" TEXT NOT NULL,
    "ownerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Image_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Image_key_key" ON "Image"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Market_imageId_key" ON "Market"("imageId");

-- AddForeignKey
ALTER TABLE "Market" ADD CONSTRAINT "Market_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;
