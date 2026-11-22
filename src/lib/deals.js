// Flash deals: one place for "what does this listing cost right now".
// A deal is active while startsAt <= now < endsAt and it has units left (maxQty null or soldQty < maxQty).
// The effective price is LEAST(listing price, deal price): a deal can never make an item dearer.
import { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';

export const activeDealWhere = (now = new Date()) => ({
  startsAt: { lte: now },
  endsAt: { gt: now },
  OR: [{ maxQty: null }, { maxQty: { gt: prisma.flashDeal.fields.soldQty } }],
});

/** Map listingId -> its active deal (the lowest one if, unusually, two overlap). `db` may be a transaction. */
export async function activeDeals(listingIds, db = prisma, now = new Date()) {
  if (listingIds.length === 0) return new Map();
  const rows = await db.flashDeal.findMany({
    where: { listingId: { in: listingIds }, ...activeDealWhere(now) },
    orderBy: { dealPrice: 'asc' },
  });
  const map = new Map();
  for (const d of rows) if (!map.has(d.listingId)) map.set(d.listingId, d);
  return map;
}

export const effectivePrice = (price, deal) => (deal ? Math.min(price, deal.dealPrice) : price);

/** The public `deal` object for a listing, or null when no deal lowers its price. */
export const presentDeal = (deal, price) =>
  deal && deal.dealPrice < price
    ? { price: deal.dealPrice, originalPrice: price, endsAt: deal.endsAt, remaining: deal.maxQty === null ? null : deal.maxQty - deal.soldQty }
    : null;

// ---------- SQL ----------
// LEFT JOIN LATERAL the active deal of listing `alias` as "dl"; then dealSql.price(alias) is the effective price.
// `alias` is a fixed table alias from our own code, never user input.
export const dealJoin = (alias, now = new Date()) => Prisma.sql`
  LEFT JOIN LATERAL (
    SELECT d.id, d."dealPrice", d."endsAt"
    FROM "FlashDeal" d
    WHERE d."listingId" = ${Prisma.raw(`${alias}.id`)}
      AND d."startsAt" <= ${now} AND d."endsAt" > ${now}
      AND (d."maxQty" IS NULL OR d."soldQty" < d."maxQty")
    ORDER BY d."dealPrice" ASC
    LIMIT 1
  ) dl ON true`;

export const effectivePriceSql = (alias) =>
  Prisma.sql`LEAST(${Prisma.raw(`${alias}.price`)}, COALESCE(dl."dealPrice", ${Prisma.raw(`${alias}.price`)}))`;
