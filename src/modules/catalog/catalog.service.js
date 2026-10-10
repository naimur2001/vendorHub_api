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

export async function listProducts(query) {
  const { q, category, brand, minPrice, maxPrice, shopId, marketId, availableOnly, sort, page, limit } = query;

  // Filters that apply to the shop listing (price, shop, market, availability)
  const listingWhere = {
    isActive: true,
    shop: { isActive: true, ...(marketId && { marketId }) },
    ...(shopId && { shopId }),
    ...((minPrice !== undefined || maxPrice !== undefined) && {
      price: {
        ...(minPrice !== undefined && { gte: minPrice }),
        ...(maxPrice !== undefined && { lte: maxPrice }),
      },
    }),
    ...(availableOnly && { availability: { not: 'OUT_OF_STOCK' } }),
  };

  // A product matches if at least one of its listings matches
  const where = {
    isActive: true,
    listings: { some: listingWhere },
    ...(q && {
      OR: [
        { title: { contains: q, mode: 'insensitive' } },
        { brand: { name: { contains: q, mode: 'insensitive' } } },
      ],
    }),
    ...(category && { category: { OR: [{ slug: category }, { parent: { slug: category } }] } }),
    ...(brand && { brand: { name: { equals: brand, mode: 'insensitive' } } }),
  };

  const rows = await prisma.product.findMany({
    where,
    include: {
      brand: { select: { id: true, name: true } },
      category: { select: { id: true, name: true, slug: true } },
      // only the listings that passed the filters, so price stats match the filters
      listings: {
        where: listingWhere,
        select: { price: true, availability: true, bargainEnabled: true },
      },
    },
  });

  const items = rows.map((p) => {
    const prices = p.listings.map((l) => l.price);
    return {
      id: p.id,
      slug: p.slug,
      title: p.title,
      brand: p.brand,
      category: p.category,
      image: p.images[0] ?? null,
      msrp: p.msrp,
      lowestPrice: Math.min(...prices),
      highestPrice: Math.max(...prices),
      shopCount: p.listings.length,
      availability: bestAvailability(p.listings),
      bargainAvailable: p.listings.some((l) => l.bargainEnabled),
      createdAt: p.createdAt,
    };
  });

  const sorters = {
    newest: (a, b) => b.createdAt - a.createdAt,
    price_asc: (a, b) => a.lowestPrice - b.lowestPrice,
    price_desc: (a, b) => b.lowestPrice - a.lowestPrice,
  };
  items.sort(sorters[sort]);

  const total = items.length;
  const start = (page - 1) * limit;
  return {
    items: items.slice(start, start + limit),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
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