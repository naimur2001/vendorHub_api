// Shipments: one per courier SubOrder (a VENDOR_DELIVERY order of a PLATFORM_COURIER shop).
//   checkout              -> Shipment PENDING (customerFee from the address's zone, codAmount, recipient)
//   order READY_FOR_PICKUP -> booked at the default courier (also POST /shops/:shopId/orders/:orderId/ship)
//   booking fails          -> stays PENDING, retried after COURIER_RETRY_MINUTES (3 tries), then the
//                             shop team and the admins are notified
//   courier events         -> webhook (signature checked) + a polling job; duplicates and older events
//                             are ignored; the order follows: PICKED_UP -> OUT_FOR_DELIVERY,
//                             DELIVERED -> COMPLETED (COD: PAID), RETURNED -> CANCELLED
// margin = customerFee - courierCost. Customers never see cost, margin, store id or raw data; shops
// never see cost or margin.
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { notify } from '../../lib/notify.js';
import { assertShopAccess } from '../../lib/shopAccess.js';
import { adapterFor, webhookSecret, CourierError } from '../../lib/couriers/index.js';
import { mapCourierStatus, PAID_OUT_EVENTS, TERMINAL, ACTIVE } from '../../lib/couriers/statusMap.js';
import { shipmentInclude, forShop } from './shipments.present.js';

export { shipmentInclude, forCustomer, forShop } from './shipments.present.js';
import {
  COURIER_RETRY_MINUTES,
  COURIER_MAX_BOOKING_TRIES,
  COURIER_BOOKING_CLAIM_MS,
  SHIPMENT_STUCK_HOURS,
  SHIPMENT_POLL_MINUTES,
} from '../../config/limits.js';
import { defaultProvider } from './delivery.service.js';
import { activeRules, profitOf } from './profitRules.service.js';
import { shopTeamIds } from '../notifications/notifications.events.js';
import { cancelEffects, addEvent } from '../fulfilment/fulfilment.service.js';
import { rewardReferralIfDue, notifyReferralReward } from '../referrals/referrals.service.js';

const HOUR_MS = 60 * 60 * 1000;

async function adminIds() {
  const rows = await prisma.user.findMany({ where: { role: 'ADMIN', isActive: true }, select: { id: true } });
  return rows.map((r) => r.id);
}

// ---------- presenters (customer / shop in shipments.present.js) ----------

const stuck = (s, now = Date.now()) => ACTIVE.includes(s.status) && now - new Date(s.statusAt).getTime() > SHIPMENT_STUCK_HOURS * HOUR_MS;

/** Admin: everything, with the target profit of the current rules (pass activeRules()). */
export function forAdmin(s, rules = []) {
  return {
    id: s.id,
    subOrderId: s.subOrderId,
    orderNumber: s.subOrder?.orderNumber ?? null,
    shop: s.shop ? { id: s.shop.id, name: s.shop.name, slug: s.shop.slug } : null,
    provider: s.provider,
    consignmentId: s.consignmentId,
    trackingCode: s.trackingCode,
    status: s.status,
    statusAt: s.statusAt,
    zoneCode: s.zoneCode,
    customerFee: s.customerFee,
    courierCost: s.courierCost,
    margin: s.margin,
    ...profitOf(rules, s), // targetProfit, profitGap, ruleId, ruleName
    codAmount: s.codAmount,
    codCollected: s.codCollected,
    codRemittedAt: s.codRemittedAt,
    shopPaidAt: s.shopPaidAt,
    bookedAt: s.bookedAt,
    pickedUpAt: s.pickedUpAt,
    deliveredAt: s.deliveredAt,
    failReason: s.failReason,
    bookingAttempts: s.bookingAttempts,
    nextAttemptAt: s.nextAttemptAt,
    lastError: s.lastError,
    ageHours: Math.floor((Date.now() - new Date(s.createdAt).getTime()) / HOUR_MS),
    stuck: stuck(s),
    createdAt: s.createdAt,
  };
}

const adminInclude = {
  ...shipmentInclude,
  subOrder: { select: { orderNumber: true, status: true, total: true, paymentMethod: true } },
  shop: { select: { id: true, name: true, slug: true } },
};
const adminDetail = (s, rules) => ({
  ...forAdmin(s, rules),
  orderStatus: s.subOrder?.status ?? null,
  recipient: s.recipient,
  events: s.events.map((e) => ({ id: e.id, status: e.status, rawStatus: e.rawStatus, note: e.note, source: e.source, at: e.at, raw: e.raw })),
});
const loadAdmin = (id) => prisma.shipment.findUnique({ where: { id }, include: adminInclude });
const adminView = async (id) => adminDetail(await loadAdmin(id), await activeRules());

// ---------- checkout ----------

/** Inside the checkout transaction: the PENDING shipment of a new courier order. */
export function createShipmentInTx(tx, { order, zone, recipient }) {
  return tx.shipment.create({
    data: {
      subOrderId: order.id,
      shopId: order.shopId,
      zoneCode: zone.code,
      customerFee: order.deliveryFee,
      codAmount: order.paymentMethod === 'CASH_ON_DELIVERY' ? order.total : 0,
      recipient,
      events: { create: [{ status: 'PENDING', rawStatus: 'created', source: 'SYSTEM', dedupeKey: `created:${order.id}`, at: new Date() }] },
    },
  });
}

// ---------- booking ----------

/**
 * Books a PENDING shipment at the default courier. Idempotent: an already booked shipment, or one
 * being booked right now, is left alone. Returns { booked, failed }.
 */
export async function bookShipment(shipmentId, { actorId = null } = {}) {
  const now = new Date();
  const claimed = await prisma.shipment.updateMany({
    where: {
      id: shipmentId,
      status: 'PENDING',
      consignmentId: null,
      OR: [{ bookingStartedAt: null }, { bookingStartedAt: { lt: new Date(now.getTime() - COURIER_BOOKING_CLAIM_MS) } }],
    },
    data: { bookingStartedAt: now },
  });
  if (claimed.count !== 1) return { booked: false, failed: false };

  const s = await prisma.shipment.findUnique({
    where: { id: shipmentId },
    include: { subOrder: { include: { items: true, shop: { select: { courierStoreId: true } } } } },
  });
  const provider = await defaultProvider();
  try {
    if (!provider) throw new CourierError('NO_PROVIDER');
    if (!s.subOrder.shop.courierStoreId) throw new CourierError('NO_STORE');
    const adapter = adapterFor(provider);
    const r = await adapter.createOrder(provider, {
      storeId: s.subOrder.shop.courierStoreId,
      merchantOrderId: s.subOrder.orderNumber,
      recipient: s.recipient,
      codAmount: s.codAmount,
      itemQuantity: s.subOrder.items.reduce((n, i) => n + i.quantity, 0),
      description: s.subOrder.items.map((i) => i.title).join(', ').slice(0, 200),
    });
    let cost = r.cost;
    if (cost === null || cost === undefined) {
      cost = (
        await adapter
          .quote(provider, { storeId: s.subOrder.shop.courierStoreId, cityId: s.recipient.cityId, zoneId: s.recipient.zoneId })
          .catch(() => ({ cost: null }))
      ).cost;
    }
    await prisma.$transaction(async (tx) => {
      await tx.shipment.update({
        where: { id: shipmentId },
        data: {
          providerId: provider.id,
          consignmentId: r.consignmentId,
          trackingCode: r.trackingCode,
          status: 'BOOKED',
          statusAt: now,
          bookedAt: now,
          courierCost: cost ?? null,
          margin: cost === null || cost === undefined ? null : s.customerFee - cost,
          bookingAttempts: { increment: 1 },
          bookingStartedAt: null,
          nextAttemptAt: null,
          lastError: null,
        },
      });
      await tx.shipmentEvent.create({
        data: { shipmentId, status: 'BOOKED', rawStatus: r.rawStatus ?? 'booked', source: 'SYSTEM', dedupeKey: `booked:${shipmentId}:${r.consignmentId}`, at: now },
      });
      await tx.auditLog.create({
        data: { actorId, action: 'shipment.booked', entityType: 'Shipment', entityId: shipmentId, meta: { provider: provider.code, orderId: s.subOrderId } },
      });
    });
    return { booked: true, failed: false };
  } catch (err) {
    const attempts = s.bookingAttempts + 1;
    const wait = COURIER_RETRY_MINUTES[attempts - 1];
    const retryAt = attempts < COURIER_MAX_BOOKING_TRIES && wait ? new Date(now.getTime() + wait * 60 * 1000) : null;
    await prisma.shipment.update({
      where: { id: shipmentId },
      data: { bookingAttempts: attempts, nextAttemptAt: retryAt, bookingStartedAt: null, lastError: err instanceof CourierError ? err.code : 'ERROR' },
    });
    if (!(err instanceof CourierError)) logger.error({ err: err.message, shipmentId }, 'shipment booking failed');
    if (!retryAt) {
      const payload = {
        type: 'SHIPMENT_BOOKING_FAILED',
        title: `Courier booking failed for ${s.subOrder.orderNumber}`,
        body: 'We could not book the courier after several tries. Our team will look into it.',
        data: { orderId: s.subOrderId, shipmentId, shopId: s.shopId },
      };
      await notify([...(await shopTeamIds(s.shopId)), ...(await adminIds())], payload);
    }
    return { booked: false, failed: true };
  }
}

/** After the shop marked a courier order ready: book it now (never throws; a failure is retried). */
export async function autoBook(orderId) {
  try {
    const s = await prisma.shipment.findUnique({ where: { subOrderId: orderId }, select: { id: true, status: true } });
    if (s?.status === 'PENDING') await bookShipment(s.id);
  } catch (err) {
    logger.error({ err: err.message, orderId }, 'automatic courier booking failed');
  }
}

/** POST /shops/:shopId/orders/:orderId/ship (shop team or admin). */
export async function shipOrder(user, shopId, orderId) {
  await assertShopAccess(user, shopId);
  const order = await prisma.subOrder.findFirst({ where: { id: orderId, shopId }, select: { id: true, status: true, shipment: { select: { id: true, status: true } } } });
  if (!order) throw new AppError(404, 'Order not found');
  if (!order.shipment) throw new AppError(409, 'This order is not delivered by the courier', { code: 'NOT_COURIER_ORDER' });
  if (!['CONFIRMED', 'READY_FOR_PICKUP'].includes(order.status)) {
    throw new AppError(409, 'Confirm the order before booking the courier', { code: 'ORDER_NOT_READY' });
  }
  let failed = false;
  if (order.shipment.status === 'PENDING') failed = (await bookShipment(order.shipment.id, { actorId: user.id })).failed;
  const s = await prisma.shipment.findUnique({ where: { id: order.shipment.id }, include: shipmentInclude });
  if (failed) throw new AppError(502, 'The courier could not be booked. We will try again shortly', { code: 'BOOKING_FAILED' });
  return forShop(s);
}

/** Job: retries bookings that are due. */
export async function retryBookings(now = new Date()) {
  const due = await prisma.shipment.findMany({
    where: { status: 'PENDING', consignmentId: null, nextAttemptAt: { lte: now }, subOrder: { status: { in: ['CONFIRMED', 'READY_FOR_PICKUP'] } } },
    select: { id: true },
    take: 50,
  });
  let booked = 0;
  for (const s of due) if ((await bookShipment(s.id)).booked) booked++;
  return { tried: due.length, booked };
}

// ---------- courier events ----------

const ORDER_OPEN = ['PLACED', 'CONFIRMED', 'READY_FOR_PICKUP', 'OUT_FOR_DELIVERY'];
const MOVING = new Set(['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY']);

async function setOrderStatus(tx, order, status, note) {
  const changed = await tx.subOrder.updateMany({ where: { id: order.id, status: order.status }, data: { status, statusAt: new Date() } });
  if (changed.count !== 1) return false;
  await addEvent(tx, order.id, status, 'SYSTEM', note);
  await tx.auditLog.create({
    data: { actorId: null, action: 'order.status_changed', entityType: 'SubOrder', entityId: order.id, meta: { from: order.status, to: status, by: 'courier' } },
  });
  return true;
}

/**
 * Applies one courier event (webhook or polling). Ignores duplicates (same dedupeKey), events older
 * than the newest one applied, and status changes after a final status. Returns what happened.
 */
export async function applyCourierEvent(shipmentId, ev) {
  let referral = null;
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Shipment" WHERE id = ${shipmentId} FOR UPDATE`; // one event at a time per shipment
    const s = await tx.shipment.findUnique({ where: { id: shipmentId }, include: { subOrder: true } });
    if (await tx.shipmentEvent.findUnique({ where: { dedupeKey: ev.dedupeKey }, select: { id: true } })) return { ignored: 'DUPLICATE' };
    if (s.lastEventAt && ev.at < s.lastEventAt) return { ignored: 'OUT_OF_ORDER' };
    if (ev.status && TERMINAL.has(s.status) && ev.status !== s.status) return { ignored: 'FINAL' };

    const changes = ev.status && ev.status !== s.status ? ev.status : null;
    const data = { lastEventAt: ev.at };
    if (changes) Object.assign(data, { status: changes, statusAt: ev.at });
    if (changes && (MOVING.has(changes) || changes === 'DELIVERED') && !s.pickedUpAt) data.pickedUpAt = ev.at;
    if (changes === 'DELIVERED') Object.assign(data, { deliveredAt: ev.at, codCollected: s.codAmount > 0 });
    if (changes === 'FAILED') data.failReason = ev.reason ?? 'The courier could not deliver';
    if (PAID_OUT_EVENTS.has(ev.rawStatus) && s.codAmount > 0 && !s.codRemittedAt) data.codRemittedAt = ev.at;
    if (ev.cost !== null && ev.cost !== undefined && s.courierCost === null) Object.assign(data, { courierCost: ev.cost, margin: s.customerFee - ev.cost });
    await tx.shipment.update({ where: { id: shipmentId }, data });
    await tx.shipmentEvent.create({
      data: { shipmentId, status: changes, rawStatus: ev.rawStatus, note: ev.reason ?? null, source: ev.source, dedupeKey: ev.dedupeKey, raw: ev.raw ?? undefined, at: ev.at },
    });

    // the order follows the shipment
    const o = s.subOrder;
    let orderStatus = null;
    if (changes && MOVING.has(changes) && ['CONFIRMED', 'READY_FOR_PICKUP'].includes(o.status)) {
      if (await setOrderStatus(tx, o, 'OUT_FOR_DELIVERY', 'Picked up by the courier')) orderStatus = 'OUT_FOR_DELIVERY';
    }
    if (changes === 'DELIVERED' && ORDER_OPEN.includes(o.status)) {
      if (await setOrderStatus(tx, o, 'COMPLETED', 'Delivered by the courier')) {
        orderStatus = 'COMPLETED';
        await tx.subOrder.update({
          where: { id: o.id },
          data: { completedAt: ev.at, ...(o.paymentMethod === 'CASH_ON_DELIVERY' && { paymentStatus: 'PAID' }) },
        });
        const session = await tx.checkoutSession.findUnique({ where: { id: o.checkoutId }, select: { userId: true } });
        referral = await rewardReferralIfDue(tx, session.userId);
      }
    }
    if (changes === 'RETURNED' && ORDER_OPEN.includes(o.status)) {
      if (await setOrderStatus(tx, o, 'CANCELLED', 'Returned by the courier')) {
        orderStatus = 'CANCELLED';
        await cancelEffects(tx, o);
      }
    }
    return { applied: true, status: changes, orderStatus, order: o, shopId: s.shopId };
  });

  if (result.applied && result.status) await notifyShipment(result);
  await notifyReferralReward(referral);
  return result;
}

const SHIPMENT_TEXT = {
  PICKED_UP: { type: 'SHIPMENT_PICKED_UP', title: 'picked up by the courier', body: 'It is on the way to you.', to: 'both' },
  DELIVERED: { type: 'SHIPMENT_DELIVERED', title: 'delivered', body: 'Thank you for shopping with us.', to: 'both' },
  FAILED: { type: 'SHIPMENT_FAILED', title: 'could not be delivered', body: 'The courier could not deliver it. They may try again.', to: 'team' },
  RETURNED: { type: 'SHIPMENT_RETURNED', title: 'returned by the courier', body: 'The parcel is coming back to the shop and the order is cancelled.', to: 'team' },
};

async function notifyShipment({ status, order, shopId }) {
  const t = SHIPMENT_TEXT[status];
  if (!t) return;
  const payload = { type: t.type, title: `Order ${order.orderNumber} ${t.title}`, body: t.body, data: { orderId: order.id, shopId, status } };
  const team = await shopTeamIds(shopId);
  if (t.to === 'both') {
    const session = await prisma.checkoutSession.findUnique({ where: { id: order.checkoutId }, select: { userId: true } });
    await notify([session?.userId, ...team], payload);
  } else {
    await notify([...team, ...(await adminIds())], payload);
  }
}

/** POST /webhooks/couriers/:code. Returns { integration } or counts; throws 401 for a bad signature. */
export async function handleWebhook(code, headers, body) {
  const provider = await prisma.courierProvider.findUnique({ where: { code } });
  const secret = webhookSecret(code);
  if (!provider || !secret) throw new AppError(404, 'Not found');
  let parsed;
  try {
    parsed = adapterFor(provider).parseWebhook(headers, body, secret);
  } catch (err) {
    if (err instanceof CourierError) throw new AppError(401, 'Invalid signature');
    throw err;
  }
  if (parsed.integration) return { integration: true };
  const out = { received: parsed.events.length, applied: 0, ignored: 0, unknown: 0 };
  for (const ev of parsed.events) {
    const s = await prisma.shipment.findFirst({ where: { providerId: provider.id, consignmentId: ev.consignmentId }, select: { id: true } });
    if (!s) {
      out.unknown++;
      continue;
    }
    const r = await applyCourierEvent(s.id, {
      ...ev,
      status: mapCourierStatus(code, ev.rawStatus),
      source: 'WEBHOOK',
      dedupeKey: `${code}:${ev.consignmentId}:${ev.rawStatus}:${ev.at.toISOString()}`,
    });
    if (r.applied) out.applied++;
    else out.ignored++;
  }
  return out;
}

/** Job: asks the courier about active shipments not heard of for a while (a missed webhook). */
export async function pollShipments(now = new Date()) {
  const cutoff = new Date(now.getTime() - (SHIPMENT_POLL_MINUTES - 5) * 60 * 1000);
  const rows = await prisma.shipment.findMany({
    where: { status: { in: ACTIVE }, consignmentId: { not: null }, OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: cutoff } }] },
    include: { provider: true },
    orderBy: { lastSyncedAt: { sort: 'asc', nulls: 'first' } },
    take: 100,
  });
  let changed = 0;
  for (const s of rows) {
    try {
      const r = await adapterFor(s.provider).track(s.provider, s.consignmentId);
      await prisma.shipment.update({ where: { id: s.id }, data: { lastSyncedAt: now } });
      const status = mapCourierStatus(s.provider.code, r.rawStatus);
      if (!status || status === s.status) continue;
      const at = r.at ?? now;
      const done = await applyCourierEvent(s.id, { status, rawStatus: r.rawStatus, at, source: 'POLL', dedupeKey: `poll:${s.id}:${r.rawStatus}:${at.toISOString()}` });
      if (done.applied) changed++;
    } catch (err) {
      logger.warn({ shipmentId: s.id, code: err.code ?? 'ERROR' }, 'shipment poll failed');
    }
  }
  return { checked: rows.length, changed };
}

// ---------- admin ----------

const CANCELLABLE = ['PENDING', 'BOOKED', 'PICKUP_ASSIGNED'];

async function adminAction(admin, id, action, check, data, event) {
  const s = await prisma.shipment.findUnique({ where: { id } });
  if (!s) throw new AppError(404, 'Shipment not found');
  check(s);
  await prisma.$transaction(async (tx) => {
    const c = await tx.shipment.updateMany({ where: { id, status: s.status, updatedAt: s.updatedAt }, data });
    if (c.count !== 1) throw new AppError(409, 'This shipment just changed. Refresh and try again.');
    if (event) await tx.shipmentEvent.create({ data: { shipmentId: id, source: 'ADMIN', dedupeKey: `admin:${id}:${action}:${Date.now()}`, at: new Date(), ...event } });
    await tx.auditLog.create({ data: { actorId: admin.id, action: `shipment.${action}`, entityType: 'Shipment', entityId: id, meta: { from: s.status, orderId: s.subOrderId } } });
  });
  return s;
}

export async function cancelShipment(admin, id) {
  const s = await prisma.shipment.findUnique({ where: { id }, include: { provider: true } });
  if (!s) throw new AppError(404, 'Shipment not found');
  if (!CANCELLABLE.includes(s.status)) throw new AppError(409, 'Only a shipment that is not picked up yet can be cancelled', { code: 'SHIPMENT_NOT_CANCELLABLE' });
  if (s.consignmentId && s.provider) {
    try {
      await adapterFor(s.provider).cancel(s.provider, s.consignmentId);
    } catch (err) {
      if (err instanceof CourierError) throw new AppError(502, 'The courier did not accept the cancellation', { code: 'COURIER_UNAVAILABLE' });
      throw err;
    }
  }
  await adminAction(admin, id, 'cancelled', () => {}, { status: 'CANCELLED', statusAt: new Date(), nextAttemptAt: null }, { status: 'CANCELLED', rawStatus: 'admin_cancel' });
  return adminView(id);
}

export async function rebookShipment(admin, id) {
  const s = await prisma.shipment.findUnique({ where: { id }, include: { subOrder: { select: { status: true } } } });
  if (!s) throw new AppError(404, 'Shipment not found');
  if (!['PENDING', 'FAILED', 'CANCELLED'].includes(s.status) || !['CONFIRMED', 'READY_FOR_PICKUP', 'OUT_FOR_DELIVERY'].includes(s.subOrder.status)) {
    throw new AppError(409, 'This shipment cannot be booked again', { code: 'SHIPMENT_NOT_REBOOKABLE' });
  }
  await adminAction(
    admin,
    id,
    'rebooked',
    () => {},
    { status: 'PENDING', statusAt: new Date(), providerId: null, consignmentId: null, trackingCode: null, courierCost: null, margin: null, bookingAttempts: 0, nextAttemptAt: null, bookingStartedAt: null, lastError: null, bookedAt: null },
    { status: 'PENDING', rawStatus: 'admin_rebook' },
  );
  await bookShipment(id, { actorId: admin.id });
  return adminView(id);
}

export async function markCodRemitted(admin, id) {
  await adminAction(
    admin,
    id,
    'cod_remitted',
    (s) => {
      if (s.status !== 'DELIVERED' || s.codAmount <= 0 || s.codRemittedAt) throw new AppError(409, 'Only a delivered cash on delivery shipment not marked yet', { code: 'NOT_DUE' });
    },
    { codRemittedAt: new Date() },
  );
  return adminView(id);
}

export async function markShopPaid(admin, id) {
  await adminAction(
    admin,
    id,
    'shop_paid',
    (s) => {
      if (s.status !== 'DELIVERED' || s.shopPaidAt) throw new AppError(409, 'Only a delivered shipment not marked yet', { code: 'NOT_DUE' });
    },
    { shopPaidAt: new Date() },
  );
  return adminView(id);
}

export async function getShipmentAdmin(id) {
  const s = await loadAdmin(id);
  if (!s) throw new AppError(404, 'Shipment not found');
  return adminDetail(s, await activeRules());
}

const dhakaStart = (day) => new Date(`${day}T00:00:00+06:00`);

export async function listShipmentsAdmin({ status, providerId, shopId, q, stuck: onlyStuck, from, to, page, limit }) {
  const and = [];
  if (status) and.push({ status });
  if (providerId) and.push({ providerId });
  if (shopId) and.push({ shopId });
  if (from) and.push({ createdAt: { gte: dhakaStart(from) } });
  if (to) and.push({ createdAt: { lt: new Date(dhakaStart(to).getTime() + 24 * HOUR_MS) } });
  if (q) and.push({ OR: [{ subOrder: { orderNumber: { contains: q, mode: 'insensitive' } } }, { trackingCode: q }, { consignmentId: q }] });
  if (onlyStuck) and.push({ status: { in: ACTIVE }, statusAt: { lt: new Date(Date.now() - SHIPMENT_STUCK_HOURS * HOUR_MS) } });
  const where = and.length ? { AND: and } : {};
  const [total, rows, rules] = await Promise.all([
    prisma.shipment.count({ where }),
    prisma.shipment.findMany({ where, include: adminInclude, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
    activeRules(),
  ]);
  return { items: rows.map((r) => forAdmin(r, rules)), pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}
