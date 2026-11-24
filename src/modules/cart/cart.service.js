import { prisma } from '../../lib/prisma.js';
import { deliveryAvailable } from '../delivery/delivery.service.js';
import { AppError } from '../../lib/errors.js';
import { recordAddToCart } from '../../lib/analytics.js';
import { activeDeals, effectivePrice, presentDeal } from '../../lib/deals.js';

const MAX_QTY_PER_LINE = 10;

const shopSelect = {
  id: true,
  name: true,
  slug: true,
  logoUrl: true,
  levelFloor: true,
  shopNumber: true,
  addressLine: true,
  verificationLevel: true,
  supportsDelivery: true,
  supportsPickup: true,
  deliveryMode: true,
  courierStoreId: true,
  isActive: true,
  market: { select: { name: true, slug: true } },
};

async function getOrCreateCart(userId) {
  return prisma.cart.upsert({ where: { userId }, update: {}, create: { userId } });
}

// stockQty is private: we enforce it but never reveal the number.
function assertQuantity(listing, qty) {
  if (qty > MAX_QTY_PER_LINE) {
    throw new AppError(400, `You can buy at most ${MAX_QTY_PER_LINE} of one item at a time`);
  }
  if (listing.stockQty !== null && qty > listing.stockQty) {
    throw new AppError(409, 'Not enough stock for that quantity');
  }
}

// 404 (not 403) for someone else's item, so item ids cannot be probed
async function findOwnItem(userId, itemId) {
  const item = await prisma.cartItem.findFirst({
    where: { id: itemId, cart: { userId } },
    include: { listing: true },
  });
  if (!item) throw new AppError(404, 'Cart item not found');
  return item;
}

// The cart grouped by shop, with live prices and per-item problem flags.
export async function getCart(userId) {
  const cart = await prisma.cart.findUnique({
    where: { userId },
    include: {
      items: {
        include: {
          listing: {
            include: {
              product: { select: { id: true, slug: true, title: true, images: true, msrp: true, isActive: true, moderationStatus: true } },
              shop: { select: shopSelect },
            },
          },
          bargain: { select: { status: true, agreedPrice: true, customerId: true } },
        },
      },
    },
  });

  const groups = new Map();
  let itemCount = 0;
  let hasProblem = false;
  const deals = await activeDeals((cart?.items ?? []).map((i) => i.listingId)); // flash deals lower the price

  for (const item of cart?.items ?? []) {
    const l = item.listing;
    const deal = deals.get(l.id);
    const price = effectivePrice(l.price, deal);

    let problem = null;
    if (!l.isActive || !l.shop.isActive || !l.product.isActive || l.product.moderationStatus !== 'APPROVED') problem = 'UNAVAILABLE';
    else if (l.availability === 'OUT_OF_STOCK') problem = 'OUT_OF_STOCK';
    else if (l.stockQty !== null && item.quantity > l.stockQty) problem = 'INSUFFICIENT_STOCK';

    // An accepted bargain for this customer overrides the listing price (built on Days 13-15)
    const bargainApplied = Boolean(
      item.bargain &&
        item.bargain.status === 'ACCEPTED' &&
        item.bargain.agreedPrice &&
        item.bargain.customerId === userId,
    );
    // const unitPrice = bargainApplied ? item.bargain.agreedPrice : l.price;
       const unitPrice = bargainApplied ? Math.min(item.bargain.agreedPrice, price) : price;
        // never pay more than the current listing price
    const lineTotal = unitPrice * item.quantity;

    if (!groups.has(l.shop.id)) {
      const { isActive, deliveryMode, courierStoreId, ...shop } = l.shop;
      // false = checkout cannot offer VENDOR_DELIVERY for this shop (courier delivery not set up yet)
      shop.deliveryAvailable = deliveryAvailable(l.shop);
      shop.courierDelivery = deliveryMode === 'PLATFORM_COURIER'; // the fee then depends on the address's zone
      groups.set(l.shop.id, { shop, items: [], subtotal: 0 });
    }
    const group = groups.get(l.shop.id);
    group.items.push({
      id: item.id,
      listingId: l.id,
      quantity: item.quantity,
      product: {
        id: l.product.id,
        slug: l.product.slug,
        title: l.product.title,
        image: l.product.images[0] ?? null,
      },
      msrp: l.product.msrp,
      unitPrice,
      lineTotal,
      deal: presentDeal(deal, l.price),
      availability: l.availability,
      bargainApplied,
      problem,
    });

    // items with a problem are shown but not counted in the subtotal
    if (!problem) group.subtotal += lineTotal;
    else hasProblem = true;
    itemCount += item.quantity;
  }

  const shops = [...groups.values()].sort((a, b) => a.shop.name.localeCompare(b.shop.name));
  return {
    shops,
    totals: {
      itemCount,
      shopCount: shops.length,
      subtotal: shops.reduce((sum, g) => sum + g.subtotal, 0),
      checkoutReady: itemCount > 0 && !hasProblem,
    },
  };
}

export async function addItem(userId, { listingId, quantity }) {
  const listing = await prisma.shopListing.findUnique({
    where: { id: listingId },
    include: { shop: { select: { isActive: true } }, product: { select: { isActive: true, moderationStatus: true } } },
  });
  const visible = listing?.product.isActive && listing.product.moderationStatus === 'APPROVED';
  if (!listing || !listing.isActive || !listing.shop.isActive || !visible) {
    throw new AppError(404, 'Listing not found');
  }
  if (listing.availability === 'OUT_OF_STOCK') {
    throw new AppError(409, 'This item is out of stock');
  }

  const cart = await getOrCreateCart(userId);
  const existing = await prisma.cartItem.findUnique({
    where: { cartId_listingId: { cartId: cart.id, listingId } },
  });

  // adding the same listing again increases its quantity
  const newQty = (existing?.quantity ?? 0) + quantity;
  // assertQuantity(listing, newQty);
     if (existing?.bargainId && newQty > 1) {
       throw new AppError(400, 'A bargained price applies to one unit only');
     }
     assertQuantity(listing, newQty);


  if (existing) {
    await prisma.cartItem.update({ where: { id: existing.id }, data: { quantity: newQty } });
  } else {
    await prisma.cartItem.create({ data: { cartId: cart.id, listingId, quantity: newQty } });
  }
  recordAddToCart(listing); // shop analytics, best effort
  return getCart(userId);
}

export async function updateItem(userId, itemId, { quantity }) {
  // const item = await findOwnItem(userId, itemId);
  
     const item = await findOwnItem(userId, itemId);
     if (item.bargainId && quantity > 1) {
       throw new AppError(400, 'A bargained price applies to one unit only');
     }
  // lowering the quantity is always allowed; raising it is checked against stock
  if (quantity > item.quantity) assertQuantity(item.listing, quantity);
  await prisma.cartItem.update({ where: { id: itemId }, data: { quantity } });
  return getCart(userId);
}

export async function removeItem(userId, itemId) {
  await findOwnItem(userId, itemId);
  await prisma.cartItem.delete({ where: { id: itemId } });
  return getCart(userId);
}

export async function clearCart(userId) {
  await prisma.cartItem.deleteMany({ where: { cart: { userId } } });
  return getCart(userId);
}