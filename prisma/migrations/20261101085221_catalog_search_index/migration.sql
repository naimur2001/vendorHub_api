-- CreateIndex
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "Product_title_idx" ON "Product" USING GIN ("title" gin_trgm_ops);
