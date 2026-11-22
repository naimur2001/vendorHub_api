import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { assertShopAccess } from '../../lib/shopAccess.js';
import { notifyPriceDrop } from '../notifications/notifications.events.js';
import { stockIsFine } from '../../lib/availability.js';

export function deriveAvailability(stockQty) {
  if (stockQty === null || stockQty === undefined) return 'AVAILABLE';
  if (stockQty === 0) return 'OUT_OF_STOCK';
  if (stockQty <= 5) return 'LIMITED';
  return 'IN_STOCK';
}

const productSelect = {
  select: { id: true, slug: true, title: true, msrp: true, images: true },
};

// The owner view includes private fields: stockQty, minOfferPercent, isActive.
// The stock is low when it is set, the alert is on, and stockQty <= lowStockAt.
export const lowStockWhere = {
  stockQty: { not: null },
  lowStockAt: { not: null },
  AND: [{ stockQty: { lte: prisma.shopListing.fields.lowStockAt } }],
};


export async function listShopListings(user, shopId, { lowStock } = {}) {
  await assertShopAccess(user, shopId);
  return prisma.shopListing.findMany({
    where: { shopId, ...(lowStock && lowStockWhere) },
    orderBy: { createdAt: 'desc' },
    include: { product: productSelect },
  });
}

export async function createListing(user, shopId, input) {
  await assertShopAccess(user, shopId);

  const product = await prisma.product.findFirst({ where: { id: input.productId, isActive: true, moderationStatus: 'APPROVED' } });
  if (!product) throw new AppError(404, 'Product not found');

  const existing = await prisma.shopListing.findUnique({
    where: { shopId_productId: { shopId, productId: input.productId } },
  });
  if (existing?.isActive) throw new AppError(409, 'This shop already lists this product');

  const data = {
    price: input.price,
    stockQty: input.stockQty ?? null,
    availability: input.availability ?? deriveAvailability(input.stockQty),
    bargainEnabled: input.bargainEnabled,
    minOfferPercent: input.minOfferPercent,
  };

  // A previously removed listing is re-activated instead of creating a duplicate
  if (existing) {
    return prisma.shopListing.update({
      where: { id: existing.id },
      data: { ...data, isActive: true },
      include: { product: productSelect },
    });
  }
  return prisma.shopListing.create({
    data: { shopId, productId: input.productId, ...data },
    include: { product: productSelect },
  });
}

export async function updateListing(user, shopId, listingId, input) {
  await assertShopAccess(user, shopId);

  const listing = await prisma.shopListing.findFirst({ where: { id: listingId, shopId } });
  if (!listing) throw new AppError(404, 'Listing not found');

  const data = { ...input };
  if (input.stockQty !== undefined && input.availability === undefined) {
    data.availability = deriveAvailability(input.stockQty);
  }
  let updated = await prisma.shopListing.update({
    where: { id: listingId },
    data,
    include: { product: productSelect },
  });
  if (updated.lowStockNotifiedAt && stockIsFine(updated)) {
    updated = await prisma.shopListing.update({
      where: { id: listingId },
      data: { lowStockNotifiedAt: null },
      include: { product: productSelect },
    });
  }
  // after the update: customers who saved this listing hear about a lower price (never throws)
  if (updated.price < listing.price) await notifyPriceDrop(listingId, updated.price);
  return updated;
}

// Soft delete: orders reference listings, so we deactivate instead of deleting.
export async function removeListing(user, shopId, listingId) {
  await assertShopAccess(user, shopId);

  const listing = await prisma.shopListing.findFirst({ where: { id: listingId, shopId } });
  if (!listing) throw new AppError(404, 'Listing not found');

  await prisma.shopListing.update({ where: { id: listingId }, data: { isActive: false } });
}