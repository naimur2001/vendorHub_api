import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

async function uniqueShopSlug(name) {
  const base = slugify(name) || 'shop';
  let slug = base;
  let n = 1;
  while (await prisma.shop.findUnique({ where: { slug } })) {
    n += 1;
    slug = `${base}-${n}`;
  }
  return slug;
}

async function findActiveShop(slug) {
  const shop = await prisma.shop.findFirst({ where: { slug, isActive: true } });
  if (!shop) throw new AppError(404, 'Shop not found');
  return shop;
}

const round1 = (n) => (n === null || n === undefined ? null : Math.round(n * 10) / 10);

// ---------- Markets ----------

export async function listMarkets() {
  const rows = await prisma.market.findMany({
    orderBy: { name: 'asc' },
    include: { _count: { select: { shops: { where: { isActive: true } } } } },
  });
  return rows.map((m) => ({
    id: m.id,
    name: m.name,
    slug: m.slug,
    city: m.city,
    address: m.address,
    shopCount: m._count.shops,
  }));
}

export async function getMarket(slug) {
  const market = await prisma.market.findUnique({
    where: { slug },
    include: {
      shops: {
        where: { isActive: true },
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          slug: true,
          logoUrl: true,
          levelFloor: true,
          shopNumber: true,
          addressLine: true,
          verificationLevel: true,
        },
      },
    },
  });
  if (!market) throw new AppError(404, 'Market not found');
  return market;
}

// ---------- Storefront ----------

export async function getShop(slug, userId) {
  const shop = await prisma.shop.findFirst({
    where: { slug, isActive: true },
    include: {
      market: { select: { id: true, name: true, slug: true } },
      _count: { select: { followers: true, staff: true } },
    },
  });
  if (!shop) throw new AppError(404, 'Shop not found');

  const [rating, ordersFulfilled, activeBargains, follow] = await Promise.all([
    prisma.review.aggregate({
      where: { shopId: shop.id, type: 'SHOP_TRUST' },
      _avg: { rating: true },
      _count: { rating: true },
    }),
    prisma.subOrder.count({ where: { shopId: shop.id, status: 'COMPLETED' } }),
    prisma.shopListing.count({
      where: {
        shopId: shop.id,
        isActive: true,
        bargainEnabled: true,
        availability: { not: 'OUT_OF_STOCK' },
      },
    }),
    userId
      ? prisma.shopFollow.findUnique({ where: { shopId_userId: { shopId: shop.id, userId } } })
      : null,
  ]);

  return {
    id: shop.id,
    name: shop.name,
    slug: shop.slug,
    description: shop.description,
    logoUrl: shop.logoUrl,
    bannerUrl: shop.bannerUrl,
    address: {
      levelFloor: shop.levelFloor,
      shopNumber: shop.shopNumber,
      addressLine: shop.addressLine,
      latitude: shop.latitude,
      longitude: shop.longitude,
    },
    market: shop.market,
    verification: { level: shop.verificationLevel, lastAuditedAt: shop.lastAuditedAt },
    supportsDelivery: shop.supportsDelivery,
    supportsPickup: shop.supportsPickup,
    stats: {
      ratingAverage: round1(rating._avg.rating),
      reviewCount: rating._count.rating,
      ordersFulfilled,
      avgResponseMins: shop.avgResponseMins,
      followers: shop._count.followers,
      activeBargains,
    },
    staffCount: shop._count.staff,
    isFollowing: Boolean(follow),
  };
}

export async function getShopProducts(slug, query) {
  const shop = await findActiveShop(slug);
  const { q, category, sort, bargainOnly, availableOnly, page, limit } = query;

  const where = {
    shopId: shop.id,
    isActive: true,
    product: {
      isActive: true,
      ...(q && { title: { contains: q, mode: 'insensitive' } }),
      ...(category && { category: { OR: [{ slug: category }, { parent: { slug: category } }] } }),
    },
    ...(bargainOnly && { bargainEnabled: true }),
    ...(availableOnly && { availability: { not: 'OUT_OF_STOCK' } }),
  };

  const orderBy = {
    newest: { createdAt: 'desc' },
    price_asc: { price: 'asc' },
    price_desc: { price: 'desc' },
  }[sort];

  const [total, rows] = await Promise.all([
    prisma.shopListing.count({ where }),
    prisma.shopListing.findMany({
      where,
      orderBy,
      skip: (page - 1) * limit,
      take: limit,
      include: {
        product: {
          select: {
            id: true,
            slug: true,
            title: true,
            images: true,
            msrp: true,
            brand: { select: { name: true } },
          },
        },
      },
    }),
  ]);

  const items = rows.map((l) => ({
    listingId: l.id,
    product: {
      id: l.product.id,
      slug: l.product.slug,
      title: l.product.title,
      brand: l.product.brand?.name ?? null,
      image: l.product.images[0] ?? null,
    },
    price: l.price,
    msrp: l.product.msrp,
    availability: l.availability,
    bargainEnabled: l.bargainEnabled,
  }));

  return { items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

export async function getShopCategories(slug) {
  const shop = await findActiveShop(slug);
  const rows = await prisma.shopListing.findMany({
    where: { shopId: shop.id, isActive: true, product: { isActive: true } },
    select: { product: { select: { category: { select: { id: true, name: true, slug: true } } } } },
  });
  const counts = new Map();
  for (const r of rows) {
    const c = r.product.category;
    const entry = counts.get(c.id) ?? { ...c, productCount: 0 };
    entry.productCount += 1;
    counts.set(c.id, entry);
  }
  return [...counts.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function getShopReviews(slug, query) {
  const shop = await findActiveShop(slug);
  const { type, page, limit } = query;
  const where = { shopId: shop.id, ...(type && { type }) };

  const [total, rows] = await Promise.all([
    prisma.review.count({ where }),
    prisma.review.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        user: { select: { name: true } },
        product: { select: { title: true, slug: true } },
      },
    }),
  ]);

  const items = rows.map((r) => ({
    id: r.id,
    type: r.type,
    rating: r.rating,
    comment: r.comment,
    createdAt: r.createdAt,
    reviewer: r.user.name,
    product: r.product,
  }));
  return { items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

// ---------- Follow ----------

const followerCount = (shopId) => prisma.shopFollow.count({ where: { shopId } });

export async function followShop(slug, userId) {
  const shop = await findActiveShop(slug);
  await prisma.shopFollow.upsert({
    where: { shopId_userId: { shopId: shop.id, userId } },
    update: {},
    create: { shopId: shop.id, userId },
  });
  return { following: true, followers: await followerCount(shop.id) };
}

export async function unfollowShop(slug, userId) {
  const shop = await findActiveShop(slug);
  await prisma.shopFollow.deleteMany({ where: { shopId: shop.id, userId } });
  return { following: false, followers: await followerCount(shop.id) };
}

// ---------- Create shop (shop owner) ----------

export async function createShop(user, input) {
  if (input.marketId) {
    const market = await prisma.market.findUnique({ where: { id: input.marketId } });
    if (!market) throw new AppError(404, 'Market not found');
  }
  const slug = await uniqueShopSlug(input.name);
  // starts as UNVERIFIED; the admin verification flow (Days 16-17) raises the level
  return prisma.shop.create({ data: { ...input, slug, ownerId: user.id } });
}