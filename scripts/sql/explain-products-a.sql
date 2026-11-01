-- DEVELOPMENT TOOL: the plan of GET /products?sort=price_asc&page=50 (limit 12), no filters
EXPLAIN (ANALYZE, BUFFERS)
SELECT p.id, m."lowestPrice", m."highestPrice", m."shopCount", m."availabilityRank", m."bargainAvailable",
       COUNT(*) OVER() AS total
FROM "Product" p
JOIN (
  SELECT l."productId",
         MIN(l.price) AS "lowestPrice",
         MAX(l.price) AS "highestPrice",
         COUNT(*)::int AS "shopCount",
         MAX(CASE l.availability WHEN 'IN_STOCK' THEN 4 WHEN 'AVAILABLE' THEN 3 WHEN 'LIMITED' THEN 2 ELSE 1 END) AS "availabilityRank",
         BOOL_OR(l."bargainEnabled") AS "bargainAvailable"
  FROM "ShopListing" l
  JOIN "Shop" s ON s.id = l."shopId"
  WHERE l."isActive" = true AND s."isActive" = true
  GROUP BY l."productId"
) m ON m."productId" = p.id
JOIN "Category" c ON c.id = p."categoryId"
LEFT JOIN "Category" pc ON pc.id = c."parentId"
LEFT JOIN "Brand" b ON b.id = p."brandId"
WHERE p."isActive" = true
ORDER BY m."lowestPrice" ASC, p.id ASC
LIMIT 12 OFFSET 588;