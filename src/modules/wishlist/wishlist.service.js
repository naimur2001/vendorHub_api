// A customer's saved listings. The user id always comes from the token, never from the request.
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { thumbFor } from '../../lib/storage.js';
import { activeDeals, effectivePrice, presentDeal } from '../../lib/deals.js';
import { MAX_WISHLIST } from '../../config/limits.js';
import { listingIdParam } from './wishlist.schema.js';

// A listing can be shown (and saved) only while the listing, its shop and its product are all active.
const visibleListing = { isActive: true, shop: { isActive: true }, product: { isActive: true } };

const listingInclude = {
  product: { select: { id: true, slug: true, title: true, images: true, msrp: true } },
  shop: {
    select: {
      id: true,
      name: true,
      slug: true,
      logoUrl: true,
      verificationLevel: true,
      market: { select: { name: true, slug: true } },
    },
  },
};

// price is the effective price: an active flash deal counts (and shows as a price drop)
const present = (item, deal = null) => {
  const l = item.listing;
  const image = l.product.images?.[0] ?? null;
  const price = effectivePrice(l.price, deal);
  return {
    listingId: l.id,
    savedAt: item.createdAt,
    priceAtSave: item.priceAtSave,
    price,
    deal: presentDeal(deal, l.price),
    priceDropped: price < item.priceAtSave,
    availability: l.availability,
    product: { id: l.product.id, slug: l.product.slug, title: l.product.title, msrp: l.product.msrp, image, thumbUrl: thumbFor(image) },
    shop: l.shop,
  };
};

const limitReached = () =>
  new AppError(409, `You can save at most ${MAX_WISHLIST} items. Remove one first.`, { code: 'WISHLIST_LIMIT' });

export async function list(userId, { page, limit }) {
  const where = { userId, listing: visibleListing }; // hidden or removed listings are left out
  const [total, rows] = await Promise.all([
    prisma.wishlistItem.count({ where }),
    prisma.wishlistItem.findMany({
      where,
      include: { listing: { include: listingInclude } },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);
  const deals = await activeDeals(rows.map((r) => r.listingId));
  return {
    items: rows.map((r) => present(r, deals.get(r.listingId))),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

// listingIds fill the hearts on shop offers; productIds (distinct) fill the hearts on product cards.
export async function ids(userId) {
  const rows = await prisma.wishlistItem.findMany({
    where: { userId, listing: visibleListing },
    select: { listingId: true, listing: { select: { productId: true } } },
    orderBy: { createdAt: 'desc' },
  });
  return {
    listingIds: rows.map((r) => r.listingId),
    productIds: [...new Set(rows.map((r) => r.listing.productId))],
  };
}

// Removes every saved listing of one product (this user only). Idempotent.
export async function removeProduct(userId, productId) {
  await prisma.wishlistItem.deleteMany({ where: { userId, listing: { productId } } });
}

// Returns { created, item }: created false when it was already saved (idempotent).
export async function add(userId, listingId) {
  const listing = await prisma.shopListing.findFirst({ where: { id: listingId, ...visibleListing }, select: { id: true } });
  if (!listing) throw new AppError(404, 'Listing not found');

  const find = () =>
    prisma.wishlistItem.findUnique({
      where: { userId_listingId: { userId, listingId } },
      include: { listing: { include: listingInclude } },
    });
  const existing = await find();
  if (existing) return { created: false, item: present(existing) };

  try {
    await prisma.$transaction(async (tx) => {
      // one add at a time per user, so two parallel adds cannot pass the limit together
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`wishlist:${userId}`}))`;
      if ((await tx.wishlistItem.count({ where: { userId } })) >= MAX_WISHLIST) throw limitReached();
      // the price is read here, inside the lock, never taken from the client
      const { price } = await tx.shopListing.findUnique({ where: { id: listingId }, select: { price: true } });
      await tx.wishlistItem.create({ data: { userId, listingId, priceAtSave: price } });
    });
  } catch (err) {
    if (err.code !== 'P2002') throw err; // P2002: saved by a parallel request a moment ago
    return { created: false, item: present(await find()) };
  }
  return { created: true, item: present(await find()) };
}

// Idempotent: removing something that is not saved is fine.
export async function remove(userId, listingId) {
  if (!listingIdParam.safeParse(listingId).success) throw new AppError(404, 'Listing not found');
  await prisma.wishlistItem.deleteMany({ where: { userId, listingId } });
}
