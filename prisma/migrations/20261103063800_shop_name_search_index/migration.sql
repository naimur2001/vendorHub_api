-- CreateIndex
CREATE INDEX "Shop_name_idx" ON "Shop" USING GIN ("name" gin_trgm_ops);
