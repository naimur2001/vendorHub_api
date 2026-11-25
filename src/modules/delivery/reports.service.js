// Admin delivery monitor. Every report takes a Dhaka day range (from/to, inclusive; default the last
// 30 days) and optional providerId / shopId. Shipments count by the day they were made; money
// (customer fees, courier cost, margin) counts on DELIVERED shipments. SQL is parameterised only.
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { RULE_JOIN, PROFIT_METRICS, BELOW_TARGET } from './profitRules.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const dhakaToday = () => new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString().slice(0, 10);
const dhakaStart = (day) => new Date(`${day}T00:00:00+06:00`);
const local = (col) => Prisma.sql`((${col}) AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Dhaka')`;

function range({ from, to }) {
  const toDay = to ?? dhakaToday();
  const fromDay = from ?? new Date(dhakaStart(toDay).getTime() - 29 * DAY_MS + 6 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (fromDay > toDay) throw new AppError(400, '"from" must not be after "to"');
  if ((dhakaStart(toDay) - dhakaStart(fromDay)) / DAY_MS > 366) throw new AppError(400, 'The range can be at most one year');
  return { fromDay, toDay, start: dhakaStart(fromDay), end: new Date(dhakaStart(toDay).getTime() + DAY_MS) };
}

const filters = ({ providerId, shopId }) =>
  Prisma.join(
    [Prisma.sql`TRUE`, providerId ? Prisma.sql`s."providerId" = ${providerId}` : null, shopId ? Prisma.sql`s."shopId" = ${shopId}` : null].filter(Boolean),
    ' AND ',
  );

const METRICS = Prisma.sql`
  count(*)::int AS "shipments",
  count(*) FILTER (WHERE s.status = 'DELIVERED')::int AS "delivered",
  count(*) FILTER (WHERE s.status = 'FAILED')::int AS "failed",
  count(*) FILTER (WHERE s.status = 'RETURNED')::int AS "returned",
  round(avg(EXTRACT(EPOCH FROM (s."pickedUpAt" - s."bookedAt")) / 60) FILTER (WHERE s."pickedUpAt" IS NOT NULL AND s."bookedAt" IS NOT NULL))::int AS "avgPickupMinutes",
  round(avg(EXTRACT(EPOCH FROM (s."deliveredAt" - s."pickedUpAt")) / 60) FILTER (WHERE s."deliveredAt" IS NOT NULL AND s."pickedUpAt" IS NOT NULL))::int AS "avgDeliveryMinutes",
  COALESCE(sum(s."customerFee") FILTER (WHERE s.status = 'DELIVERED'), 0)::int AS "customerFees",
  COALESCE(sum(s."courierCost") FILTER (WHERE s.status = 'DELIVERED'), 0)::int AS "courierCost",
  COALESCE(sum(s.margin) FILTER (WHERE s.status = 'DELIVERED'), 0)::int AS "margin",
  COALESCE(sum(s."codAmount") FILTER (WHERE s.status = 'DELIVERED' AND s."codAmount" > 0 AND s."codRemittedAt" IS NULL), 0)::int AS "codOwedByCourier",
  COALESCE(sum(o.total - o."deliveryFee") FILTER (WHERE s.status = 'DELIVERED' AND s."shopPaidAt" IS NULL), 0)::int AS "owedToShops",
  ${PROFIT_METRICS}`;

const withRate = (r) => {
  const finished = r.delivered + r.failed + r.returned;
  return { ...r, successRate: finished ? Math.round((r.delivered / finished) * 1000) / 10 : null };
};

export async function summary(q) {
  const { fromDay, toDay, start, end } = range(q);
  const where = Prisma.sql`s."createdAt" >= ${start} AND s."createdAt" < ${end} AND ${filters(q)}`;
  const [[totals], byStatus] = await Promise.all([
    prisma.$queryRaw`SELECT ${METRICS}, ${BELOW_TARGET} FROM "Shipment" s JOIN "SubOrder" o ON o.id = s."subOrderId" ${RULE_JOIN} WHERE ${where}`,
    prisma.$queryRaw`SELECT s.status::text AS status, count(*)::int AS count FROM "Shipment" s WHERE ${where} GROUP BY s.status`,
  ]);
  return { from: fromDay, to: toDay, countsByStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.count])), ...withRate(totals) };
}

export async function timeseries(q) {
  const { fromDay, toDay, start, end } = range(q);
  const f = filters(q);
  const [booked, delivered, failed, placed] = await Promise.all([
    // the target profit counts on the day the shipment was booked (when the courier cost is known)
    prisma.$queryRaw`SELECT ${local(Prisma.sql`s."bookedAt"`)}::date AS day, count(*)::int AS n, ${PROFIT_METRICS}
      FROM "Shipment" s ${RULE_JOIN} WHERE s."bookedAt" >= ${start} AND s."bookedAt" < ${end} AND ${f} GROUP BY 1`,
    prisma.$queryRaw`SELECT ${local(Prisma.sql`s."deliveredAt"`)}::date AS day, count(*)::int AS n,
        COALESCE(sum(s."customerFee"), 0)::int AS fees, COALESCE(sum(s."courierCost"), 0)::int AS cost, COALESCE(sum(s.margin), 0)::int AS margin
      FROM "Shipment" s WHERE s.status = 'DELIVERED' AND s."deliveredAt" >= ${start} AND s."deliveredAt" < ${end} AND ${f} GROUP BY 1`,
    prisma.$queryRaw`SELECT ${local(Prisma.sql`e."at"`)}::date AS day, count(DISTINCT e."shipmentId")::int AS n
      FROM "ShipmentEvent" e JOIN "Shipment" s ON s.id = e."shipmentId"
      WHERE e.status = 'FAILED' AND e."at" >= ${start} AND e."at" < ${end} AND ${f} GROUP BY 1`,
    prisma.$queryRaw`SELECT ${local(Prisma.sql`o."createdAt"`)}::date AS day, count(*)::int AS n, COALESCE(sum(o.total), 0)::int AS value
      FROM "Shipment" s JOIN "SubOrder" o ON o.id = s."subOrderId"
      WHERE o."createdAt" >= ${start} AND o."createdAt" < ${end} AND ${f} GROUP BY 1`,
  ]);
  const key = (d) => new Date(d).toISOString().slice(0, 10);
  const idx = (rows) => new Map(rows.map((r) => [key(r.day), r]));
  const [b, d, fl, p] = [idx(booked), idx(delivered), idx(failed), idx(placed)];
  const points = [];
  for (let t = dhakaStart(fromDay).getTime(); t < end.getTime(); t += DAY_MS) {
    const day = new Date(t + 6 * 60 * 60 * 1000).toISOString().slice(0, 10);
    points.push({
      day,
      booked: b.get(day)?.n ?? 0,
      delivered: d.get(day)?.n ?? 0,
      failed: fl.get(day)?.n ?? 0,
      customerFees: d.get(day)?.fees ?? 0,
      courierCost: d.get(day)?.cost ?? 0,
      margin: d.get(day)?.margin ?? 0,
      ordersPlaced: p.get(day)?.n ?? 0,
      orderValue: p.get(day)?.value ?? 0,
      targetProfit: b.get(day)?.targetProfit ?? null,
      profitGap: b.get(day)?.profitGap ?? null,
    });
  }
  return { from: fromDay, to: toDay, interval: 'day', points };
}

async function grouped(q, by) {
  const { fromDay, toDay, start, end } = range(q);
  const where = Prisma.sql`s."createdAt" >= ${start} AND s."createdAt" < ${end} AND ${filters(q)}`;
  const rows =
    by === 'shop'
      ? await prisma.$queryRaw`SELECT sh.id AS "shopId", sh.name AS "shopName", sh.slug AS "shopSlug", ${METRICS}
          FROM "Shipment" s JOIN "SubOrder" o ON o.id = s."subOrderId" JOIN "Shop" sh ON sh.id = s."shopId" ${RULE_JOIN}
          WHERE ${where} GROUP BY sh.id, sh.name, sh.slug ORDER BY "delivered" DESC, "margin" DESC`
      : await prisma.$queryRaw`SELECT p.id AS "providerId", p.code::text AS "providerCode", p.name AS "providerName", ${METRICS}
          FROM "Shipment" s JOIN "SubOrder" o ON o.id = s."subOrderId" JOIN "CourierProvider" p ON p.id = s."providerId" ${RULE_JOIN}
          WHERE ${where} GROUP BY p.id, p.code, p.name ORDER BY "delivered" DESC, "margin" DESC`;
  return { from: fromDay, to: toDay, items: rows.map(withRate) };
}

export const byShop = (q) => grouped(q, 'shop');
export const byProvider = (q) => grouped(q, 'provider');
