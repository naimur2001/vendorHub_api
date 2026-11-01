import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';

const AVAILABILITY_RANK = { IN_STOCK: 4, AVAILABLE: 3, LIMITED: 2, OUT_OF_STOCK: 1 };

// The "best" availability among a product's listings (used on product cards).
const bestAvailability = (listings) =>
  listings.reduce(
    (best, l) => (AVAILABILITY_RANK[l.availability] > AVAILABILITY_RANK[best] ? l.availability : best),
    'OUT_OF_STOCK',
  );

export async function listCategories() {
  const rows = await prisma.category.findMany({
    orderBy: { name: 'asc' },
    include: { _count: { select: { products: true } } },
  });
  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    parentId: c.parentId,
    productCount: c._count.products,
  }));
}

export async function listBrands() {
  const rows = await prisma.brand.findMany({
    orderBy: { name: 'asc' },
    include: { _count: { select: { products: true } } },
  });
  return rows.map((b) => ({ id: b.id, name: b.name, productCount: b._count.products }));
}

// GET /products: filtering, grouping, sorting, counting and paging happen IN THE DATABASE,
// so one request reads only one page of products. Every user value is passed as a parameter
// (Prisma.sql); the only hand-written SQL pieces are fixed texts such as the ORDER BY variants.
const RANK_TO_AVAILABILITY = { 4: 'IN_STOCK', 3: 'AVAILABLE', 2: 'LIMITED', 1: 'OUT_OF_STOCK' };

const ORDER_BY = {
  newest: Prisma.sql`fp."createdAt" DESC, fp.id ASC`,
  price_asc: Prisma.sql`m."lowestPrice" ASC, fp.id ASC`,
  price_desc: Prisma.sql`m."lowestPrice" DESC, fp.id ASC`,
};


// "%" and "_" (and the escape character itself) in a search text are normal characters, not wildcards.
const likePattern = (text) => `%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

export async function listProducts(query) {
  const { q, category, brand, minPrice, maxPrice, shopId, marketId, availableOnly, sort, page, limit } = query;

  // Product filters, written on Product columns only, so PostgreSQL can use their indexes
  // (trigram index on the title, existing indexes on brandId and categoryId).
  const productConds = [Prisma.sql`p."isActive" = true`];
  if (q) {
    const pattern = likePattern(q);
    productConds.push(Prisma.sql`(p.title ILIKE ${pattern} ESCAPE '\\'
      OR p."brandId" IN (SELECT id FROM "Brand" WHERE name ILIKE ${pattern} ESCAPE '\\'))`);
  }
  if (category) {
    // the category itself or any of its subcategories
    productConds.push(Prisma.sql`p."categoryId" IN (
      SELECT id FROM "Category" WHERE slug = ${category}
      UNION
      SELECT id FROM "Category" WHERE "parentId" IN (SELECT id FROM "Category" WHERE slug = ${category}))`);
  }
  if (brand) {
    productConds.push(Prisma.sql`p."brandId" IN (SELECT id FROM "Brand" WHERE lower(name) = lower(${brand}))`);
  }

  // Listing filters: a product appears if at least ONE of its listings passes all of them,
  // and its price range, shop count, availability and bargain flag come from those listings only.
  const listingConds = [Prisma.sql`l."isActive" = true`, Prisma.sql`s."isActive" = true`];
  if (marketId) listingConds.push(Prisma.sql`s."marketId" = ${marketId}`);
  if (shopId) listingConds.push(Prisma.sql`l."shopId" = ${shopId}`);
  if (minPrice !== undefined) listingConds.push(Prisma.sql`l.price >= ${minPrice}`);
  if (maxPrice !== undefined) listingConds.push(Prisma.sql`l.price <= ${maxPrice}`);
  if (availableOnly) listingConds.push(Prisma.sql`l.availability <> 'OUT_OF_STOCK'`);

  // fp: the products that pass the product filters.
  // m:  per product, the statistics of its MATCHING listings; only the listings of fp are read,
  //     so a search or a category filter groups a small part of the listings, not all of them.
  const base = Prisma.sql`
    WITH fp AS (
      SELECT p.id, p."createdAt"
      FROM "Product" p
      WHERE ${Prisma.join(productConds, ' AND ')}
    ),
    m AS (
      SELECT l."productId",
             MIN(l.price) AS "lowestPrice",
             MAX(l.price) AS "highestPrice",
             COUNT(*)::int AS "shopCount",
             MAX(CASE l.availability
                   WHEN 'IN_STOCK' THEN 4 WHEN 'AVAILABLE' THEN 3 WHEN 'LIMITED' THEN 2 ELSE 1
                 END) AS "availabilityRank",
             BOOL_OR(l."bargainEnabled") AS "bargainAvailable"
      FROM "ShopListing" l
      JOIN fp ON fp.id = l."productId"
      JOIN "Shop" s ON s.id = l."shopId"
      WHERE ${Prisma.join(listingConds, ' AND ')}
      GROUP BY l."productId"
    )`;

  // One page, in a stable order (id breaks ties), with the total of all matches in every row.
  const offset = (page - 1) * limit;
  const rows = await prisma.$queryRaw`
    ${base}
    SELECT fp.id, m."lowestPrice", m."highestPrice", m."shopCount", m."availabilityRank", m."bargainAvailable",
           COUNT(*) OVER() AS total
    FROM fp
    JOIN m ON m."productId" = fp.id
    ORDER BY ${ORDER_BY[sort]}
    LIMIT ${limit} OFFSET ${offset}`;

  // An empty page past the end has no row to carry the total, so it needs one extra count.
  let total = 0;
  if (rows.length > 0) total = Number(rows[0].total);
  else if (page > 1) {
    const counted = await prisma.$queryRaw`${base} SELECT COUNT(*) AS total FROM fp JOIN m ON m."productId" = fp.id`;
    total = Number(counted[0].total);
  }

  // Only this page's products are loaded with Prisma; the SQL order is kept.
  const products = rows.length
    ? await prisma.product.findMany({
        where: { id: { in: rows.map((r) => r.id) } },
        include: {
          brand: { select: { id: true, name: true } },
          category: { select: { id: true, name: true, slug: true } },
        },
      })
    : [];
  const byId = new Map(products.map((p) => [p.id, p]));

  const items = rows.map((r) => {
    const p = byId.get(r.id);
    return {
      id: p.id,
      slug: p.slug,
      title: p.title,
      brand: p.brand,
      category: p.category,
      image: p.images[0] ?? null,
      msrp: p.msrp,
      lowestPrice: r.lowestPrice,
      highestPrice: r.highestPrice,
      shopCount: r.shopCount,
      availability: RANK_TO_AVAILABILITY[r.availabilityRank],
      bargainAvailable: r.bargainAvailable,
      createdAt: p.createdAt,
    };
  });

  return { items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

export async function getProduct(slug, listingId) {
  const product = await prisma.product.findFirst({
    where: { slug, isActive: true },
    include: {
      brand: true,
      category: { select: { id: true, name: true, slug: true } },
      listings: {
        where: { isActive: true, shop: { isActive: true } },
        orderBy: { price: 'asc' },
        include: {
          shop: {
            select: {
              id: true,
              name: true,
              slug: true,
              logoUrl: true,
              levelFloor: true,
              shopNumber: true,
              addressLine: true,
              verificationLevel: true,
              lastAuditedAt: true,
              supportsDelivery: true,
              supportsPickup: true,
              avgResponseMins: true,
              market: { select: { id: true, name: true, slug: true } },
            },
          },
        },
      },
    },
  });
  if (!product) throw new AppError(404, 'Product not found');

  // Shop trust rating per shop (shop reviews only, not product reviews)
  const shopIds = [...new Set(product.listings.map((l) => l.shopId))];
  const ratingRows = shopIds.length
    ? await prisma.review.groupBy({
        by: ['shopId'],
        where: { type: 'SHOP_TRUST', shopId: { in: shopIds } },
        _avg: { rating: true },
        _count: { rating: true },
      })
    : [];
  const ratings = new Map(
    ratingRows.map((r) => [
      r.shopId,
      { average: Math.round(r._avg.rating * 10) / 10, count: r._count.rating },
    ]),
  );

  const toListing = (l) => ({
    id: l.id,
    price: l.price,
    availability: l.availability,
    bargainEnabled: l.bargainEnabled,
    discountPercent: product.msrp ? Math.round((1 - l.price / product.msrp) * 100) : null,
    shop: { ...l.shop, rating: ratings.get(l.shop.id) ?? { average: null, count: 0 } },
  });

  // Selected listing: the one in the URL, else the cheapest that is not out of stock
  let selected;
  if (listingId) {
    selected = product.listings.find((l) => l.id === listingId);
    if (!selected) throw new AppError(404, 'Listing not found for this product');
  } else {
    selected = product.listings.find((l) => l.availability !== 'OUT_OF_STOCK') ?? product.listings[0];
  }
  const others = product.listings.filter((l) => l !== selected);

  return {
    product: {
      id: product.id,
      slug: product.slug,
      title: product.title,
      description: product.description,
      specs: product.specs,
      images: product.images,
      msrp: product.msrp,
      brand: product.brand && { id: product.brand.id, name: product.brand.name },
      category: product.category,
    },
    selectedListing: selected ? toListing(selected) : null,
    otherListings: others.map(toListing),
    otherShopsCount: others.length,
  };
}

// Compare table: every shop's listing for this product, cheapest first
export async function getProductListings(slug) {
  const { selectedListing, otherListings } = await getProduct(slug);
  return [selectedListing, ...otherListings].filter(Boolean).sort((a, b) => a.price - b.price);
}