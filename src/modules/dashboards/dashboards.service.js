import { prisma } from '../../lib/prisma.js';
import { assertShopAccess } from '../../lib/shopAccess.js';

const ORDER_STATUSES = ['PLACED', 'CONFIRMED', 'READY_FOR_PICKUP', 'OUT_FOR_DELIVERY', 'COMPLETED', 'CANCELLED'];
const LEVELS = ['UNVERIFIED', 'DOCUMENTS_VERIFIED', 'BUSINESS_VERIFIED', 'PHYSICAL_SHOP_VERIFIED', 'TRUSTED_VENDOR'];
const ROLES = ['CUSTOMER', 'SHOP_OWNER', 'SHOP_STAFF', 'ADMIN'];
const LIVE_BARGAINS = ['AWAITING_SHOP', 'COUNTERED', 'ACCEPTED'];
const OPEN_VERIFICATION = ['PENDING', 'AUTO_FLAGGED', 'CORRECTION_REQUESTED'];
const DAY = 24 * 60 * 60 * 1000;
const ago = (ms) => new Date(Date.now() - ms);

// { PLACED: 0, CONFIRMED: 0, ... } filled from a groupBy result, so every key is always present
function countsBy(groups, keys, field) {
  const out = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const g of groups) out[g[field]] = g._count._all;
  return out;
}

const sumCounts = (groups) => groups.reduce((n, g) => n + g._count._all, 0);

// Orders and revenue since a moment. Cancelled orders are ignored; revenue includes delivery fees.
async function salesSince(where, since) {
  const r = await prisma.subOrder.aggregate({
    where: { ...where, status: { not: 'CANCELLED' }, createdAt: { gte: since } },
    _count: { _all: true },
    _sum: { total: true },
  });
  return { orders: r._count._all, revenue: r._sum.total ?? 0 };
}

async function salesWindows(where) {
  const [last24h, last7d, last30d] = await Promise.all([
    salesSince(where, ago(DAY)),
    salesSince(where, ago(7 * DAY)),
    salesSince(where, ago(30 * DAY)),
  ]);
  return { last24h, last7d, last30d };
}

const roundOne = (n) => (n === null || n === undefined ? null : Math.round(n * 10) / 10);

// ---------- customer ----------

export async function customerDashboard(user) {
  const orderWhere = { checkout: { userId: user.id } };
  const [groups, recent, cart, bargains, following, completed, reviewed] = await Promise.all([
    prisma.subOrder.groupBy({ by: ['status'], where: orderWhere, _count: { _all: true }, _sum: { total: true } }),
    prisma.subOrder.findMany({
      where: orderWhere,
      orderBy: { createdAt: 'desc' },
      take: 5,
      include: {
        shop: { select: { id: true, name: true, slug: true } },
        items: { select: { title: true, quantity: true } },
      },
    }),
    prisma.cart.findUnique({
      where: { userId: user.id },
      include: { items: { select: { quantity: true, listing: { select: { shopId: true } } } } },
    }),
    prisma.bargain.findMany({
      where: { customerId: user.id, status: { in: LIVE_BARGAINS }, expiresAt: { gt: new Date() } },
      select: { status: true },
    }),
    prisma.shopFollow.count({ where: { userId: user.id } }),
    prisma.subOrder.findMany({
      where: { ...orderWhere, status: 'COMPLETED' },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, shop: { select: { id: true, name: true, slug: true } } },
    }),
    prisma.review.findMany({ where: { userId: user.id, type: 'SHOP_TRUST' }, select: { shopId: true } }),
  ]);

  // completed orders whose shop I have not rated yet (one entry per shop)
  const ratedShops = new Set(reviewed.map((r) => r.shopId));
  const seen = new Set();
  const toReview = [];
  for (const o of completed) {
    if (ratedShops.has(o.shop.id) || seen.has(o.shop.id)) continue;
    seen.add(o.shop.id);
    toReview.push({ orderId: o.id, shop: o.shop });
    if (toReview.length === 5) break;
  }

  const items = cart?.items ?? [];
  const inStatus = (s) => bargains.filter((b) => b.status === s).length;
  return {
    orders: {
      total: sumCounts(groups),
      byStatus: countsBy(groups, ORDER_STATUSES, 'status'),
      totalSpent: groups.find((g) => g.status === 'COMPLETED')?._sum.total ?? 0,
      recent: recent.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        status: o.status,
        paymentStatus: o.paymentStatus,
        deliveryMethod: o.deliveryMethod,
        total: o.total,
        createdAt: o.createdAt,
        shop: o.shop,
        items: o.items,
      })),
    },
    cart: {
      itemCount: items.reduce((n, i) => n + i.quantity, 0),
      shopCount: new Set(items.map((i) => i.listing.shopId)).size,
    },
    bargains: {
      active: bargains.length,
      waitingForMe: inStatus('COUNTERED'),
      acceptedReadyToBuy: inStatus('ACCEPTED'),
    },
    following,
    toReview,
  };
}

// ---------- shop ----------

export async function shopDashboard(user, shopId) {
  await assertShopAccess(user, shopId);
  const where = { shopId };
  const since30 = ago(30 * DAY);
  const lowStockWhere = { shopId, isActive: true, availability: { in: ['LIMITED', 'OUT_OF_STOCK'] } };

  const [
    shop, groups, sales, completedRevenue, ordersToConfirm, awaitingPayment, bargainsWaiting,
    lowStockCount, lowStock, listingGroups, lastVerification, rating, followers, top, recent,
  ] = await Promise.all([
    prisma.shop.findUnique({
      where: { id: shopId },
      select: { name: true, slug: true, isActive: true, verificationLevel: true, avgResponseMins: true },
    }),
    prisma.subOrder.groupBy({ by: ['status'], where, _count: { _all: true } }),
    salesWindows(where),
    prisma.subOrder.aggregate({
      where: { ...where, status: 'COMPLETED', updatedAt: { gte: since30 } },
      _sum: { total: true },
    }),
    // placed orders the shop can confirm now (cash orders, or online orders that are already paid)
    prisma.subOrder.count({
      where: { ...where, status: 'PLACED', OR: [{ paymentMethod: { not: 'ONLINE' } }, { paymentStatus: 'PAID' }] },
    }),
    prisma.subOrder.count({
      where: { ...where, status: 'PLACED', paymentMethod: 'ONLINE', paymentStatus: { not: 'PAID' } },
    }),
    prisma.bargain.count({
      where: { listing: { shopId }, status: 'AWAITING_SHOP', expiresAt: { gt: new Date() } },
    }),
    prisma.shopListing.count({ where: lowStockWhere }),
    prisma.shopListing.findMany({
      where: lowStockWhere,
      orderBy: { updatedAt: 'desc' },
      take: 10,
      select: {
        id: true,
        availability: true,
        stockQty: true,
        price: true,
        product: { select: { title: true, slug: true } },
      },
    }),
    prisma.shopListing.groupBy({ by: ['isActive'], where, _count: { _all: true } }),
    prisma.shopVerification.findFirst({
      where,
      orderBy: { submittedAt: 'desc' },
      select: { id: true, status: true, targetLevel: true },
    }),
    prisma.review.aggregate({
      where: { shopId, type: 'SHOP_TRUST' },
      _avg: { rating: true },
      _count: { rating: true },
    }),
    prisma.shopFollow.count({ where }),
    prisma.orderItem.groupBy({
      by: ['title'],
      where: { subOrder: { shopId, status: { not: 'CANCELLED' }, createdAt: { gte: since30 } } },
      _sum: { quantity: true },
      orderBy: { _sum: { quantity: 'desc' } },
      take: 5,
    }),
    prisma.subOrder.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 5,
      include: { checkout: { select: { user: { select: { name: true } } } } },
    }),
  ]);

  const listingCount = (active) => listingGroups.find((g) => g.isActive === active)?._count._all ?? 0;
  return {
    shop: { id: shopId, ...shop },
    orders: {
      total: sumCounts(groups),
      byStatus: countsBy(groups, ORDER_STATUSES, 'status'),
      recent: recent.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        status: o.status,
        paymentMethod: o.paymentMethod,
        paymentStatus: o.paymentStatus,
        deliveryMethod: o.deliveryMethod,
        total: o.total,
        createdAt: o.createdAt,
        customer: o.checkout.user.name,
      })),
    },
    sales: { ...sales, completedRevenueLast30d: completedRevenue._sum.total ?? 0 },
    actions: { ordersToConfirm, ordersAwaitingPayment: awaitingPayment, bargainsWaiting, lowStockCount, lowStock },
    listings: { active: listingCount(true), inactive: listingCount(false) },
    verification: {
      level: shop.verificationLevel,
      openRequest:
        lastVerification && OPEN_VERIFICATION.includes(lastVerification.status) ? lastVerification : null,
      lastRequest: lastVerification,
    },
    reputation: { ratingAverage: roundOne(rating._avg.rating), reviewCount: rating._count.rating, followers },
    topProducts30d: top.map((t) => ({ title: t.title, unitsSold: t._sum.quantity ?? 0 })),
  };
}

// ---------- admin ----------

export async function adminDashboard() {
  const weekAgo = ago(7 * DAY);
  const [
    userRoles, blockedUsers, newUsers, shopLevels, activeShops, newShops, orderStatuses, sales,
    pendingReview, autoFlagged, correctionRequested, approvedThisWeek, liveBargains,
    products, activeListings, reviews, topShopRows, activity,
  ] = await Promise.all([
    prisma.user.groupBy({ by: ['role'], _count: { _all: true } }),
    prisma.user.count({ where: { isActive: false } }),
    prisma.user.count({ where: { createdAt: { gte: weekAgo } } }),
    prisma.shop.groupBy({ by: ['verificationLevel'], _count: { _all: true } }),
    prisma.shop.count({ where: { isActive: true } }),
    prisma.shop.count({ where: { createdAt: { gte: weekAgo } } }),
    prisma.subOrder.groupBy({ by: ['status'], _count: { _all: true } }),
    salesWindows({}),
    prisma.shopVerification.count({ where: { status: 'PENDING' } }),
    prisma.shopVerification.count({ where: { status: 'AUTO_FLAGGED' } }),
    prisma.shopVerification.count({ where: { status: 'CORRECTION_REQUESTED' } }),
    prisma.shopVerification.count({ where: { status: 'APPROVED', reviewedAt: { gte: weekAgo } } }),
    prisma.bargain.count({ where: { status: { in: LIVE_BARGAINS }, expiresAt: { gt: new Date() } } }),
    prisma.product.count({ where: { isActive: true } }),
    prisma.shopListing.count({ where: { isActive: true } }),
    prisma.review.count(),
    prisma.subOrder.groupBy({
      by: ['shopId'],
      where: { status: { not: 'CANCELLED' }, createdAt: { gte: ago(30 * DAY) } },
      _sum: { total: true },
      _count: { _all: true },
      orderBy: { _sum: { total: 'desc' } },
      take: 5,
    }),
    prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 8,
      include: { actor: { select: { name: true } } },
    }),
  ]);

  const shopNames = topShopRows.length
    ? await prisma.shop.findMany({
        where: { id: { in: topShopRows.map((r) => r.shopId) } },
        select: { id: true, name: true, slug: true },
      })
    : [];
  const nameOf = new Map(shopNames.map((s) => [s.id, s]));
  const totalShops = sumCounts(shopLevels);

  return {
    users: {
      total: sumCounts(userRoles),
      byRole: countsBy(userRoles, ROLES, 'role'),
      blocked: blockedUsers,
      newLast7d: newUsers,
    },
    shops: {
      total: totalShops,
      active: activeShops,
      inactive: totalShops - activeShops,
      byLevel: countsBy(shopLevels, LEVELS, 'verificationLevel'),
      newLast7d: newShops,
    },
    orders: { total: sumCounts(orderStatuses), byStatus: countsBy(orderStatuses, ORDER_STATUSES, 'status'), sales },
    verification: { pendingReview, autoFlagged, waitingForOwner: correctionRequested, approvedThisWeek },
    bargains: { live: liveBargains },
    catalog: { products, activeListings, reviews },
    topShops30d: topShopRows.map((r) => ({
      shopId: r.shopId,
      name: nameOf.get(r.shopId)?.name ?? null,
      slug: nameOf.get(r.shopId)?.slug ?? null,
      orders: r._count._all,
      revenue: r._sum.total ?? 0,
    })),
    recentActivity: activity.map((a) => ({
      id: a.id,
      action: a.action,
      entityType: a.entityType,
      entityId: a.entityId,
      actor: a.actor?.name ?? null,
      createdAt: a.createdAt,
    })),
  };
}