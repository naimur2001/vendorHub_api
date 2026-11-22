-- AlterTable
ALTER TABLE "Market" ADD COLUMN     "weeklyHoliday" INTEGER;

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "hours" JSONB,
ADD COLUMN     "weeklyHoliday" INTEGER;
