import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { assertShopAccess } from '../../lib/shopAccess.js';

function deriveAvailability(stockQty) {
  if (stockQty === null || stockQty === undefined) return 'AVAILABLE';
  if (stockQty === 0) return 'OUT_OF_STOCK';
  if (stockQty <= 5) return 'LIMITED';
  return 'IN_STOCK';
}

const productSelect = {
  select: { id: true, slug: true, title: true, msrp: true, images: true },
};

// The owner view includes private fields: stockQty, minOfferPercent, isActive.
export async function listShopListings(user, shopId) {
  await assertShopAccess(user, shopId);
  return prisma.shopListing.findMany({
    where: { shopId },
    orderBy: { createdAt: 'desc' },
    include: { product: productSelect },
  });
}

export async function createListing(user, shopId, input) {
  await assertShopAccess(user, shopId);

  const product = await prisma.product.findFirst({ where: { id: input.productId, isActive: true } });
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
  return prisma.shopListing.update({
    where: { id: listingId },
    data,
    include: { product: productSelect },
  });
}

// Soft delete: orders reference listings, so we deactivate instead of deleting.
export async function removeListing(user, shopId, listingId) {
  await assertShopAccess(user, shopId);

  const listing = await prisma.shopListing.findFirst({ where: { id: listingId, shopId } });
  if (!listing) throw new AppError(404, 'Listing not found');

  await prisma.shopListing.update({ where: { id: listingId }, data: { isActive: false } });
}