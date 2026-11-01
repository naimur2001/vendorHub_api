-- DEVELOPMENT TOOL: the plan of the NEW query for GET /products?q=laptop&sort=price_asc (limit 12)
EXPLAIN (ANALYZE, BUFFERS)
WITH fp AS (
  SELECT p.id, p."createdAt"
  FROM "Product" p
  WHERE p."isActive" = true
    AND (p.title ILIKE '%laptop%' ESCAPE '\'
         OR p."brandId" IN (SELECT id FROM "Brand" WHERE name ILIKE '%laptop%' ESCAPE '\'))
),
m AS (
  SELECT l."productId",
         MIN(l.price) AS "lowestPrice",
         MAX(l.price) AS "highestPrice",
         COUNT(*)::int AS "shopCount",
         MAX(CASE l.availability WHEN 'IN_STOCK' THEN 4 WHEN 'AVAILABLE' THEN 3 WHEN 'LIMITED' THEN 2 ELSE 1 END) AS "availabilityRank",
         BOOL_OR(l."bargainEnabled") AS "bargainAvailable"
  FROM "ShopListing" l
  JOIN fp ON fp.id = l."productId"
  JOIN "Shop" s ON s.id = l."shopId"
  WHERE l."isActive" = true AND s."isActive" = true
  GROUP BY l."productId"
)
SELECT fp.id, m."lowestPrice", m."highestPrice", m."shopCount", m."availabilityRank", m."bargainAvailable",
       COUNT(*) OVER() AS total
FROM fp
JOIN m ON m."productId" = fp.id
ORDER BY m."lowestPrice" ASC, fp.id ASC
LIMIT 12 OFFSET 0;