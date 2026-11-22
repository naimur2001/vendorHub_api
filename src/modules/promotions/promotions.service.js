// Flash deals and coupons. Prices and discounts are always computed here, never taken from the client.
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { assertShopTeam } from '../../lib/shopAccess.js';
import { thumbFor } from '../../lib/storage.js';
import { activeDealWhere } from '../../lib/deals.js';
import { refundCredit } from '../referrals/referrals.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_DEAL_DAYS = 30;
const audit = (tx, user, action, entityType, entityId, meta) =>
  tx.auditLog.create({ data: { actorId: user.id, action, entityType, entityId, meta } });

// ---------- coupons at checkout ----------
const couponError = (message, code) => new AppError(400, message, { code });

/** The discount (taka) a coupon gives on an items' subtotal. */
export const couponDiscount = (coupon, subtotal) =>
  coupon.percentOff ? Math.floor((subtotal * coupon.percentOff) / 100) : Math.min(coupon.amountOff, subtotal);

// Checks and redeems a coupon for ONE shop order, inside the checkout transaction (one redemption
// of a code at a time, so maxUses and perCustomer hold under parallel checkouts). Fixed messages:
// the code itself is never echoed.
export async function redeemCoupon(tx, userId, shopId, code, subtotal, now = new Date()) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`coupon:${code}`}))`;
  const coupon = await tx.coupon.findUnique({ where: { code } });
  if (!coupon || coupon.shopId !== shopId || !coupon.isActive) {
    throw couponError('This coupon code is not valid for this shop', 'COUPON_INVALID');
  }
  if (now < coupon.startsAt) throw couponError('This coupon is not active yet', 'COUPON_NOT_STARTED');
  if (now >= coupon.endsAt) throw couponError('This coupon has expired', 'COUPON_EXPIRED');
  if (subtotal < coupon.minOrder) {
    throw couponError(`This coupon needs an order of at least ${coupon.minOrder} taka from this shop`, 'COUPON_MIN_ORDER');
  }
  if (coupon.maxUses !== null && coupon.usedCount >= coupon.maxUses) throw couponError('This coupon has been used up', 'COUPON_USED_UP');
  const used = await tx.couponRedemption.count({ where: { couponId: coupon.id, userId } });
  if (used >= coupon.perCustomer) throw couponError('You have already used this coupon', 'COUPON_ALREADY_USED');

  await tx.coupon.update({ where: { id: coupon.id }, data: { usedCount: { increment: 1 } } });
  return { id: coupon.id, code: coupon.code, discount: couponDiscount(coupon, subtotal) };
}

// A cancelled order gives back its flash-deal units and its coupon use (the order keeps its numbers).
export async function releasePromotions(tx, orderId) {
  const items = await tx.orderItem.findMany({ where: { subOrderId: orderId, flashDealId: { not: null } } });
  for (const i of items) {
    await tx.flashDeal.updateMany({
      where: { id: i.flashDealId, soldQty: { gte: i.quantity } },
      data: { soldQty: { decrement: i.quantity } },
    });
  }
  const redemption = await tx.couponRedemption.findUnique({ where: { subOrderId: orderId } });
  if (redemption) {
    await tx.couponRedemption.delete({ where: { id: redemption.id } });
    await tx.coupon.updateMany({ where: { id: redemption.couponId, usedCount: { gt: 0 } }, data: { usedCount: { decrement: 1 } } });
  }
  await refundCredit(tx, orderId); // referral credit spent on it comes back (once)
}

// ---------- flash deals (shop team) ----------
const dealStatus = (d, now = new Date()) => {
  if (now < d.startsAt) return 'SCHEDULED';
  if (now >= d.endsAt) return 'ENDED';
  if (d.maxQty !== null && d.soldQty >= d.maxQty) return 'SOLD_OUT';
  return 'ACTIVE';
};
const presentShopDeal = (d) => ({
  id: d.id,
  listingId: d.listingId,
  productTitle: d.listing?.product.title ?? null,
  listPrice: d.listing?.price ?? null,
  dealPrice: d.dealPrice,
  startsAt: d.startsAt,
  endsAt: d.endsAt,
  maxQty: d.maxQty,
  soldQty: d.soldQty,
  status: dealStatus(d),
});
const dealInclude = { listing: { select: { price: true, product: { select: { title: true } } } } };

export async function createDeal(user, shopId, input) {
  await assertShopTeam(user, shopId);
  const listing = await prisma.shopListing.findFirst({ where: { id: input.listingId, shopId, isActive: true } });
  if (!listing) throw new AppError(404, 'Listing not found');
  if (input.dealPrice >= listing.price) throw new AppError(400, 'The deal price must be lower than the listing price');
  const startsAt = input.startsAt ?? new Date();
  const { endsAt } = input;
  if (endsAt <= startsAt) throw new AppError(400, 'endsAt must be after startsAt');
  if (endsAt.getTime() - startsAt.getTime() > MAX_DEAL_DAYS * DAY_MS) throw new AppError(400, `A deal can last at most ${MAX_DEAL_DAYS} days`);
  if (endsAt <= new Date()) throw new AppError(400, 'endsAt must be in the future');

  const deal = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`deal:${listing.id}`}))`;
    // at most one deal per listing at any moment: no overlapping time windows
    const overlap = await tx.flashDeal.count({ where: { listingId: listing.id, startsAt: { lt: endsAt }, endsAt: { gt: startsAt } } });
    if (overlap) throw new AppError(409, 'This listing already has a deal in that time', { code: 'DEAL_OVERLAP' });
    const d = await tx.flashDeal.create({
      data: { listingId: listing.id, dealPrice: input.dealPrice, startsAt, endsAt, maxQty: input.maxQty ?? null, createdById: user.id },
      include: dealInclude,
    });
    await audit(tx, user, 'deal.created', 'FlashDeal', d.id, { listingId: listing.id, dealPrice: d.dealPrice, startsAt, endsAt });
    return d;
  });
  return presentShopDeal(deal);
}

export async function listShopDeals(user, shopId) {
  await assertShopTeam(user, shopId);
  const rows = await prisma.flashDeal.findMany({ where: { listing: { shopId } }, include: dealInclude, orderBy: { startsAt: 'desc' }, take: 200 });
  return rows.map(presentShopDeal);
}

// Not started yet: deleted. Running: ended now (the orders keep their deal price).
export async function endDeal(user, shopId, dealId) {
  await assertShopTeam(user, shopId);
  const deal = await prisma.flashDeal.findFirst({ where: { id: dealId, listing: { shopId } } });
  if (!deal) throw new AppError(404, 'Deal not found');
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    if (deal.startsAt > now) await tx.flashDeal.delete({ where: { id: dealId } });
    else if (deal.endsAt > now) await tx.flashDeal.update({ where: { id: dealId }, data: { endsAt: now } });
    await audit(tx, user, 'deal.ended', 'FlashDeal', dealId, { listingId: deal.listingId });
  });
}

// ---------- public: the home page "Flash deals" row ----------
export async function publicDeals({ limit }) {
  const now = new Date();
  const rows = await prisma.flashDeal.findMany({
    where: {
      ...activeDealWhere(now),
      listing: { isActive: true, shop: { isActive: true }, product: { isActive: true, moderationStatus: 'APPROVED' } },
    },
    orderBy: [{ endsAt: 'asc' }, { id: 'asc' }], // ending soonest first
    take: limit * 2, // a few spare in case a deal is not lower than a since-lowered price
    include: {
      listing: {
        select: {
          id: true,
          price: true,
          availability: true,
          product: { select: { id: true, slug: true, title: true, images: true } },
          shop: { select: { id: true, name: true, slug: true } },
        },
      },
    },
  });
  return rows
    .filter((d) => d.dealPrice < d.listing.price)
    .slice(0, limit)
    .map((d) => {
      const image = d.listing.product.images[0] ?? null;
      return {
        dealId: d.id,
        listingId: d.listing.id,
        price: d.dealPrice,
        originalPrice: d.listing.price,
        percentOff: Math.round((1 - d.dealPrice / d.listing.price) * 100),
        endsAt: d.endsAt,
        remaining: d.maxQty === null ? null : d.maxQty - d.soldQty,
        availability: d.listing.availability,
        product: { id: d.listing.product.id, slug: d.listing.product.slug, title: d.listing.product.title, image, thumbUrl: thumbFor(image) },
        shop: d.listing.shop,
      };
    });
}

// ---------- coupons (shop team) ----------
const presentCoupon = (c) => ({
  id: c.id,
  code: c.code,
  percentOff: c.percentOff,
  amountOff: c.amountOff,
  minOrder: c.minOrder,
  startsAt: c.startsAt,
  endsAt: c.endsAt,
  maxUses: c.maxUses,
  usedCount: c.usedCount,
  perCustomer: c.perCustomer,
  isActive: c.isActive,
  createdAt: c.createdAt,
});

export async function createCoupon(user, shopId, input) {
  await assertShopTeam(user, shopId);
  const startsAt = input.startsAt ?? new Date();
  if (input.endsAt <= startsAt) throw new AppError(400, 'endsAt must be after startsAt');
  try {
    const coupon = await prisma.$transaction(async (tx) => {
      const c = await tx.coupon.create({
        data: {
          code: input.code,
          shopId,
          percentOff: input.percentOff ?? null,
          amountOff: input.amountOff ?? null,
          minOrder: input.minOrder ?? 0,
          startsAt,
          endsAt: input.endsAt,
          maxUses: input.maxUses ?? null,
          perCustomer: input.perCustomer ?? 1,
        },
      });
      await audit(tx, user, 'coupon.created', 'Coupon', c.id, { shopId, percentOff: c.percentOff, amountOff: c.amountOff });
      return c;
    });
    return presentCoupon(coupon);
  } catch (err) {
    if (err.code === 'P2002') throw new AppError(409, 'This coupon code is already taken', { code: 'COUPON_CODE_TAKEN' });
    throw err;
  }
}

export async function listCoupons(user, shopId) {
  await assertShopTeam(user, shopId);
  const rows = await prisma.coupon.findMany({ where: { shopId }, orderBy: { createdAt: 'desc' }, take: 200 });
  return rows.map(presentCoupon);
}

export async function updateCoupon(user, shopId, couponId, input) {
  await assertShopTeam(user, shopId);
  const coupon = await prisma.coupon.findFirst({ where: { id: couponId, shopId } });
  if (!coupon) throw new AppError(404, 'Coupon not found');
  if (input.endsAt && input.endsAt <= coupon.startsAt) throw new AppError(400, 'endsAt must be after startsAt');
  const updated = await prisma.$transaction(async (tx) => {
    const c = await tx.coupon.update({ where: { id: couponId }, data: input });
    await audit(tx, user, 'coupon.updated', 'Coupon', couponId, { fields: Object.keys(input) });
    return c;
  });
  return presentCoupon(updated);
}
