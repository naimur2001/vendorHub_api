import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';

const DAY = 24 * 60 * 60 * 1000;
const REPORT_TZ = 'Asia/Dhaka'; // reports cut days in local time

// Default: the last 30 days. `to` is exclusive. At most 366 days.
function resolveRange({ from, to }) {
  const end = to ?? new Date();
  const start = from ?? new Date(end.getTime() - 30 * DAY);
  if (start >= end) throw new AppError(400, 'The start of the range must be before its end');
  if (end - start > 366 * DAY) throw new AppError(400, 'The range can be at most 366 days');
  return { start, end };
}

// ---------- vendors ----------

export async function listShops({ q, verificationLevel, isActive, marketId, page, limit }) {
  const where = {
    ...(q && { name: { contains: q, mode: 'insensitive' } }),
    ...(verificationLevel && { verificationLevel }),
    ...(isActive !== undefined && { isActive }),
    ...(marketId && { marketId }),
  };

  const [total, shops] = await Promise.all([
    prisma.shop.count({ where }),
    prisma.shop.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        owner: { select: { name: true, email: true } },
        market: { select: { name: true } },
        _count: { select: { listings: true, followers: true } },
      },
    }),
  ]);

  // statistics for the whole page with two queries instead of two per shop
  const ids = shops.map((s) => s.id);
  const [orderStats, ratings] = ids.length
    ? await Promise.all([
        prisma.subOrder.groupBy({
          by: ['shopId'],
          where: { shopId: { in: ids }, status: { not: 'CANCELLED' } },
          _count: { _all: true },
          _sum: { total: true },
        }),
        prisma.review.groupBy({
          by: ['shopId'],
          where: { shopId: { in: ids }, type: 'SHOP_TRUST' },
          _avg: { rating: true },
          _count: { rating: true },
        }),
      ])
    : [[], []];
  const orderOf = new Map(orderStats.map((o) => [o.shopId, o]));
  const ratingOf = new Map(ratings.map((r) => [r.shopId, r]));

  return {
    items: shops.map((s) => ({
      id: s.id,
      name: s.name,
      slug: s.slug,
      isActive: s.isActive,
      createdAt: s.createdAt,
      verificationLevel: s.verificationLevel,
      lastAuditedAt: s.lastAuditedAt,
      owner: s.owner,
      market: s.market?.name ?? null,
      stats: {
        listings: s._count.listings,
        followers: s._count.followers,
        orders: orderOf.get(s.id)?._count._all ?? 0,
        revenue: orderOf.get(s.id)?._sum.total ?? 0,
        ratingAverage: ratingOf.has(s.id) ? Math.round(ratingOf.get(s.id)._avg.rating * 10) / 10 : null,
        reviewCount: ratingOf.get(s.id)?._count.rating ?? 0,
      },
    })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function setShopStatus(admin, shopId, { isActive, reason }) {
  const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { id: true, isActive: true } });
  if (!shop) throw new AppError(404, 'Shop not found');
  if (shop.isActive === isActive) {
    throw new AppError(409, isActive ? 'This shop is already active' : 'This shop is already deactivated');
  }

  await prisma.$transaction(async (tx) => {
    await tx.shop.update({ where: { id: shopId }, data: { isActive } });
    await tx.auditLog.create({
      data: {
        actorId: admin.id,
        action: isActive ? 'shop.reactivated' : 'shop.deactivated',
        entityType: 'Shop',
        entityId: shopId,
        meta: { reason },
      },
    });
  });
  return { shopId, isActive };
}

// ---------- reports ----------

export async function salesReport(query) {
  const { start, end } = resolveRange(query);
  // date_trunc cuts the days in Dhaka time; the column stores UTC
  const raw = await prisma.$queryRaw`
    SELECT date_trunc(${query.interval}, ("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${REPORT_TZ}) AS period,
           COUNT(*)::int AS orders,
           COALESCE(SUM("total"), 0)::int AS revenue
    FROM "SubOrder"
    WHERE "status" <> 'CANCELLED' AND "createdAt" >= ${start} AND "createdAt" < ${end}
    GROUP BY 1
    ORDER BY 1`;

  const rows = raw.map((r) => ({
    period: r.period.toISOString().slice(0, 10), // the first day of the day, week or month
    orders: r.orders,
    revenue: r.revenue,
  }));
  const orders = rows.reduce((n, r) => n + r.orders, 0);
  const revenue = rows.reduce((n, r) => n + r.revenue, 0);
  return {
    from: start,
    to: end,
    interval: query.interval,
    timezone: REPORT_TZ,
    rows,
    totals: { orders, revenue, averageOrderValue: orders > 0 ? Math.round(revenue / orders) : 0 },
  };
}

export async function topReport(query) {
  const { start, end } = resolveRange(query);
  const when = { status: { not: 'CANCELLED' }, createdAt: { gte: start, lt: end } };

  const [shopRows, productRows] = await Promise.all([
    prisma.subOrder.groupBy({
      by: ['shopId'],
      where: when,
      _sum: { total: true },
      _count: { _all: true },
      orderBy: { _sum: { total: 'desc' } },
      take: query.limit,
    }),
    prisma.orderItem.groupBy({
      by: ['title'],
      where: { subOrder: when },
      _sum: { quantity: true },
      orderBy: { _sum: { quantity: 'desc' } },
      take: query.limit,
    }),
  ]);

  const shops = shopRows.length
    ? await prisma.shop.findMany({
        where: { id: { in: shopRows.map((r) => r.shopId) } },
        select: { id: true, name: true, slug: true },
      })
    : [];
  const shopOf = new Map(shops.map((s) => [s.id, s]));

  return {
    from: start,
    to: end,
    shops: shopRows.map((r) => ({
      shopId: r.shopId,
      name: shopOf.get(r.shopId)?.name ?? null,
      slug: shopOf.get(r.shopId)?.slug ?? null,
      orders: r._count._all,
      revenue: r._sum.total ?? 0,
    })),
    products: productRows.map((r) => ({ title: r.title, unitsSold: r._sum.quantity ?? 0 })),
  };
}