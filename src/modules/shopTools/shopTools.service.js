// Owner tools for one shop (owner or staff only): analytics and CSV import of listings.
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { assertShopTeam } from '../../lib/shopAccess.js';
import { deriveAvailability, stockIsFine } from '../../lib/availability.js';
import { parseCsv } from '../../lib/csv.js';
import { dhakaDay, dayValue } from '../../lib/analytics.js';
import { notifyPriceDrop } from '../notifications/notifications.events.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000; // Asia/Dhaka is UTC+6 all year (no daylight saving)

// ---------- analytics ----------
// Per Dhaka day (oldest first, every day present):
//   views         unique visitors of the shop's listings' product pages
//   addToCarts    add-to-cart actions
//   orders        orders placed that day (cancelled ones excluded)
//   revenue       the total (taka) of those orders
//   bargainOffers bargains started on the shop's listings; bargainsAccepted = of those, accepted
// topListings: the 5 listings with the most views in the range (then units sold).
export async function analytics(user, shopId, { range }) {
  await assertShopTeam(user, shopId);
  const days = range === '30d' ? 30 : 7;
  const to = dhakaDay();
  const from = dhakaDay(new Date(dayValue(to).getTime() - (days - 1) * DAY_MS + 12 * 60 * 60 * 1000));
  const fromUtc = new Date(dayValue(from).getTime() - DHAKA_OFFSET_MS); // Dhaka midnight of `from`
  const localDay = (col) => Prisma.sql`((${col} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Dhaka')::date`;

  const [views, carts, orders, bargains, listingViews, listingCarts, listingSales] = await Promise.all([
    prisma.listingView.groupBy({ by: ['day'], where: { shopId, day: { gte: dayValue(from) } }, _count: { _all: true } }),
    prisma.addToCartEvent.groupBy({ by: ['day'], where: { shopId, day: { gte: dayValue(from) } }, _count: { _all: true } }),
    prisma.$queryRaw`
      SELECT ${localDay(Prisma.sql`o."createdAt"`)} AS day, COUNT(*)::int AS orders, COALESCE(SUM(o.total), 0)::int AS revenue
      FROM "SubOrder" o
      WHERE o."shopId" = ${shopId} AND o.status <> 'CANCELLED' AND o."createdAt" >= ${fromUtc}
      GROUP BY 1`,
    prisma.$queryRaw`
      SELECT ${localDay(Prisma.sql`b."createdAt"`)} AS day, COUNT(*)::int AS offers,
             COUNT(*) FILTER (WHERE b."agreedPrice" IS NOT NULL)::int AS accepted
      FROM "Bargain" b JOIN "ShopListing" l ON l.id = b."listingId"
      WHERE l."shopId" = ${shopId} AND b."createdAt" >= ${fromUtc}
      GROUP BY 1`,
    prisma.listingView.groupBy({ by: ['listingId'], where: { shopId, day: { gte: dayValue(from) } }, _count: { _all: true } }),
    prisma.addToCartEvent.groupBy({ by: ['listingId'], where: { shopId, day: { gte: dayValue(from) } }, _count: { _all: true } }),
    prisma.$queryRaw`
      SELECT i."listingId", SUM(i.quantity)::int AS units, SUM(i.quantity * i."unitPrice")::int AS revenue
      FROM "OrderItem" i JOIN "SubOrder" o ON o.id = i."subOrderId"
      WHERE o."shopId" = ${shopId} AND o.status <> 'CANCELLED' AND o."createdAt" >= ${fromUtc}
      GROUP BY i."listingId"`,
  ]);

  const key = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d));
  const byDay = (rows, pick) => new Map(rows.map((r) => [key(r.day), pick(r)]));
  const v = byDay(views, (r) => r._count._all);
  const c = byDay(carts, (r) => r._count._all);
  const o = byDay(orders, (r) => r);
  const b = byDay(bargains, (r) => r);

  const series = [];
  for (let t = dayValue(from).getTime(); t <= dayValue(to).getTime(); t += DAY_MS) {
    const d = new Date(t).toISOString().slice(0, 10);
    series.push({
      date: d,
      views: v.get(d) ?? 0,
      addToCarts: c.get(d) ?? 0,
      orders: o.get(d)?.orders ?? 0,
      revenue: o.get(d)?.revenue ?? 0,
      bargainOffers: b.get(d)?.offers ?? 0,
      bargainsAccepted: b.get(d)?.accepted ?? 0,
    });
  }
  const sum = (k) => series.reduce((n, d) => n + d[k], 0);
  const totals = {
    views: sum('views'),
    addToCarts: sum('addToCarts'),
    orders: sum('orders'),
    revenue: sum('revenue'),
    bargainOffers: sum('bargainOffers'),
    bargainsAccepted: sum('bargainsAccepted'),
  };
  totals.bargainWinRate = totals.bargainOffers ? Math.round((totals.bargainsAccepted / totals.bargainOffers) * 1000) / 10 : null;

  // top 5 listings: most views, then most units sold
  const stats = new Map();
  const stat = (id) => stats.get(id) ?? stats.set(id, { listingId: id, views: 0, addToCarts: 0, unitsSold: 0, revenue: 0 }).get(id);
  for (const r of listingViews) stat(r.listingId).views = r._count._all;
  for (const r of listingCarts) stat(r.listingId).addToCarts = r._count._all;
  for (const r of listingSales) Object.assign(stat(r.listingId), { unitsSold: r.units, revenue: r.revenue });
  const top = [...stats.values()].sort((a, z) => z.views - a.views || z.unitsSold - a.unitsSold || (a.listingId < z.listingId ? -1 : 1)).slice(0, 5);
  const listings = await prisma.shopListing.findMany({
    where: { id: { in: top.map((t) => t.listingId) } },
    select: { id: true, price: true, product: { select: { title: true, slug: true } } },
  });
  const info = new Map(listings.map((l) => [l.id, l]));

  return {
    range,
    timeZone: 'Asia/Dhaka',
    from,
    to,
    days: series,
    totals,
    topListings: top.map((t) => ({
      ...t,
      productTitle: info.get(t.listingId)?.product.title ?? null,
      productSlug: info.get(t.listingId)?.product.slug ?? null,
      price: info.get(t.listingId)?.price ?? null,
    })),
  };
}

// ---------- CSV import ----------
export const MAX_IMPORT_ROWS = 500;
const COLUMNS = ['productslug', 'title', 'category', 'price', 'stockqty', 'availability'];
const AVAILABILITY = ['IN_STOCK', 'AVAILABLE', 'LIMITED', 'OUT_OF_STOCK'];
const MAX_PRICE = 10_000_000;

// Columns: productSlug, or title + category (an EXISTING product: the CSV never creates products),
// price, stockQty (empty = not tracked), availability (empty = from stockQty).
// Every row is checked first; if any row is wrong nothing is saved (422 with every error). Otherwise
// all rows are saved in ONE transaction: a listing of this shop for that product is updated
// (and re-activated), else created.
export async function importListings(user, shopId, file) {
  await assertShopTeam(user, shopId);
  if (!file) throw new AppError(400, 'Send exactly one CSV file in the multipart field "file"');
  if (file.buffer.includes(0)) throw new AppError(400, 'The file is not a text CSV file');

  let rows;
  try {
    ({ rows } = parseCsv(file.buffer.toString('utf8')));
  } catch (err) {
    throw new AppError(400, `The CSV could not be read: ${err.message}`); // fixed parser messages only
  }
  if (rows.length < 2) throw new AppError(400, 'The CSV needs a header row and at least one data row');
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const unknown = header.filter((h) => !COLUMNS.includes(h));
  if (unknown.length) throw new AppError(400, 'Unknown columns. Use: productSlug, title, category, price, stockQty, availability');
  if (new Set(header).size !== header.length) throw new AppError(400, 'A column appears twice');
  if (!header.includes('price')) throw new AppError(400, 'The price column is required');
  if (!header.includes('productslug') && !(header.includes('title') && header.includes('category'))) {
    throw new AppError(400, 'Use a productSlug column, or title and category columns');
  }
  const data = rows.slice(1);
  if (data.length > MAX_IMPORT_ROWS) throw new AppError(413, `At most ${MAX_IMPORT_ROWS} rows per file`);

  const col = (r, name) => {
    const i = header.indexOf(name);
    return i === -1 ? '' : (r[i] ?? '').trim();
  };

  // look up every product with two queries
  const slugs = [...new Set(data.map((r) => col(r, 'productslug')).filter(Boolean))];
  const byTitle = data.filter((r) => !col(r, 'productslug') && col(r, 'title') && col(r, 'category'));
  const [slugProducts, titleProducts] = await Promise.all([
    slugs.length ? prisma.product.findMany({ where: { slug: { in: slugs }, isActive: true }, select: { id: true, slug: true } }) : [],
    byTitle.length
      ? prisma.product.findMany({
          where: {
            isActive: true,
            OR: byTitle.map((r) => ({ title: { equals: col(r, 'title'), mode: 'insensitive' }, category: { slug: col(r, 'category').toLowerCase() } })),
          },
          select: { id: true, title: true, category: { select: { slug: true } } },
        })
      : [],
  ]);
  const bySlug = new Map(slugProducts.map((p) => [p.slug, p.id]));
  const titleKey = (title, cat) => `${title.toLowerCase()}|${cat.toLowerCase()}`;
  const byTitleKey = new Map();
  for (const p of titleProducts) {
    const k = titleKey(p.title, p.category.slug);
    byTitleKey.set(k, byTitleKey.has(k) ? 'AMBIGUOUS' : p.id);
  }

  const errors = [];
  const planned = [];
  const seen = new Map();
  data.forEach((r, i) => {
    const row = i + 2; // the line in a spreadsheet: row 1 is the header
    const fail = (message) => errors.push({ row, message });
    if (r.length > header.length) return fail('More values than columns');

    let productId;
    const slug = col(r, 'productslug');
    if (slug) {
      productId = bySlug.get(slug);
      if (!productId) return fail('No active product with this productSlug');
    } else if (col(r, 'title') && col(r, 'category')) {
      productId = byTitleKey.get(titleKey(col(r, 'title'), col(r, 'category')));
      if (!productId) return fail('No product with this title in this category (add it first, or use productSlug)');
      if (productId === 'AMBIGUOUS') return fail('Several products have this title in this category: use productSlug');
    } else {
      return fail('Give a productSlug, or a title and a category');
    }
    if (seen.has(productId)) return fail(`The same product is already in row ${seen.get(productId)}`);
    seen.set(productId, row);

    const priceText = col(r, 'price');
    if (!/^\d+$/.test(priceText) || Number(priceText) < 1 || Number(priceText) > MAX_PRICE) {
      return fail(`price must be a whole number of taka from 1 to ${MAX_PRICE}`);
    }
    const stockText = col(r, 'stockqty');
    if (stockText && (!/^\d+$/.test(stockText) || Number(stockText) > 1_000_000)) return fail('stockQty must be a whole number from 0, or empty');
    const stockQty = stockText ? Number(stockText) : null;
    const availText = col(r, 'availability').toUpperCase();
    if (availText && !AVAILABILITY.includes(availText)) return fail(`availability must be one of ${AVAILABILITY.join(', ')}, or empty`);

    planned.push({ productId, price: Number(priceText), stockQty, availability: availText || deriveAvailability(stockQty) });
  });

  if (errors.length) {
    throw new AppError(422, 'Some rows are invalid. Nothing was saved.', { created: 0, updated: 0, errors });
  }

  const existing = await prisma.shopListing.findMany({
    where: { shopId, productId: { in: planned.map((p) => p.productId) } },
    select: { id: true, productId: true, price: true, isActive: true },
  });
  const current = new Map(existing.map((l) => [l.productId, l]));
  const priceDrops = [];

  const result = await prisma.$transaction(
    async (tx) => {
      let created = 0;
      let updated = 0;
      for (const p of planned) {
        const old = current.get(p.productId);
        if (old) {
          const l = await tx.shopListing.update({
            where: { id: old.id },
            data: { price: p.price, stockQty: p.stockQty, availability: p.availability, isActive: true },
          });
          if (l.lowStockNotifiedAt && stockIsFine(l)) await tx.shopListing.update({ where: { id: l.id }, data: { lowStockNotifiedAt: null } });
          if (old.isActive && p.price < old.price) priceDrops.push({ id: old.id, price: p.price });
          updated++;
        } else {
          await tx.shopListing.create({
            data: { shopId, productId: p.productId, price: p.price, stockQty: p.stockQty, availability: p.availability },
          });
          created++;
        }
      }
      await tx.auditLog.create({
        data: { actorId: user.id, action: 'listing.imported', entityType: 'Shop', entityId: shopId, meta: { rows: planned.length, created, updated } },
      });
      return { created, updated };
    },
    { timeout: 30000 },
  );
  for (const d of priceDrops) await notifyPriceDrop(d.id, d.price); // customers who saved it (never throws)
  return { ...result, errors: [] };
}
