CREATE EXTENSION IF NOT EXISTS vector;

-- AlterTable
ALTER TABLE "Image" ADD COLUMN     "embedding" vector(512);

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "titleEmbedding" vector(512);
