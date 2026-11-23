// Admin order monitor: every shop's orders, late orders, investigation and interventions.
// ADMIN only. Every call is written to the audit log (searches without the search text).
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { notify } from '../../lib/notify.js';
import { shopTeamIds, notifyStatusChange } from '../notifications/notifications.events.js';
import { cancelEffects, addEvent } from '../fulfilment/fulfilment.service.js';
import { reservationTimes } from '../checkout/checkout.service.js';
import {
  LATE_UNCONFIRMED_HOURS, LATE_DELIVERY_HOURS, LATE_PICKUP_DAYS, SHOP_REMINDER_EVERY_MS,
  RESERVATION_CONFIRM_MINUTES, CHAT_PAGE,
} from '../../config/limits.js';

const HOUR = 60 * 60 * 1000;
const STATUSES = ['PLACED', 'CONFIRMED', 'READY_FOR_PICKUP', 'OUT_FOR_DELIVERY', 'COMPLETED', 'CANCELLED'];
const LATE_KINDS = ['unconfirmed', 'delivery', 'pickup'];
const OPEN_RETURN = ['REQUESTED', 'REJECTED', 'ESCALATED']; // REJECTED can still be escalated
const NOT_FOUND = 'Order not found';

// ---------- late rules ----------
const lateCutoffs = (now) => ({
  unconfirmed: new Date(now.getTime() - LATE_UNCONFIRMED_HOURS * HOUR),
  reservation: new Date(now.getTime() - RESERVATION_CONFIRM_MINUTES * 60 * 1000), // its confirmBy has passed
  delivery: new Date(now.getTime() - LATE_DELIVERY_HOURS * HOUR),
  pickup: new Date(now.getTime() - LATE_PICKUP_DAYS * 24 * HOUR),
});

function lateWhere(kind, now) {
  const c = lateCutoffs(now);
  if (kind === 'unconfirmed') {
    return {
      status: 'PLACED',
      OR: [
        { deliveryMethod: { not: 'RESERVE_PICKUP' }, createdAt: { lt: c.unconfirmed } },
        { deliveryMethod: 'RESERVE_PICKUP', createdAt: { lt: c.reservation } },
      ],
    };
  }
  if (kind === 'delivery') return { status: 'OUT_FOR_DELIVERY', statusAt: { lt: c.delivery } };
  if (kind === 'pickup') return { status: 'READY_FOR_PICKUP', statusAt: { lt: c.pickup } };
  return { OR: LATE_KINDS.map((k) => lateWhere(k, now)) }; // any
}

/** 'unconfirmed' | 'delivery' | 'pickup' | null, by the same rules as lateWhere. */
export function lateReason(o, now = new Date()) {
  const c = lateCutoffs(now);
  if (o.status === 'PLACED') {
    const cutoff = o.deliveryMethod === 'RESERVE_PICKUP' ? c.reservation : c.unconfirmed;
    return o.createdAt < cutoff ? 'unconfirmed' : null;
  }
  if (o.status === 'OUT_FOR_DELIVERY') return o.statusAt < c.delivery ? 'delivery' : null;
  if (o.status === 'READY_FOR_PICKUP') return o.statusAt < c.pickup ? 'pickup' : null;
  return null;
}

export const countLate = (now = new Date()) => prisma.subOrder.count({ where: lateWhere('any', now) });

// ---------- audit ----------
const audit = (actorId, action, entityId, meta, tx = prisma) =>
  tx.auditLog.create({ data: { actorId, action, entityType: 'SubOrder', entityId, meta: meta ?? undefined } });

// A Dhaka calendar day (YYYY-MM-DD) as a UTC moment.
const dhakaStart = (day) => new Date(`${day}T00:00:00+06:00`);

// ---------- list ----------
function baseWhere({ shopId, deliveryMethod, paymentMethod, paymentStatus, q, from, to }) {
  const and = [];
  if (shopId) and.push({ shopId });
  if (deliveryMethod) and.push({ deliveryMethod });
  if (paymentMethod) and.push({ paymentMethod });
  if (paymentStatus) and.push({ paymentStatus });
  if (from) and.push({ createdAt: { gte: dhakaStart(from) } });
  if (to) and.push({ createdAt: { lt: new Date(dhakaStart(to).getTime() + 24 * HOUR) } });
  if (q) {
    and.push({
      OR: [
        { orderNumber: { contains: q, mode: 'insensitive' } },
        { checkout: { user: { phone: { contains: q } } } },
        { checkout: { user: { email: { contains: q, mode: 'insensitive' } } } },
      ],
    });
  }
  return and.length ? { AND: and } : {};
}

const listSelect = {
  id: true,
  orderNumber: true,
  status: true,
  statusAt: true,
  deliveryMethod: true,
  deliveryFee: true,
  paymentMethod: true,
  paymentStatus: true,
  total: true,
  createdAt: true,
  reservedUntil: true,
  shop: { select: { id: true, name: true, slug: true } },
  checkout: { select: { user: { select: { name: true, phone: true } } } },
  returns: { where: { status: { in: OPEN_RETURN } }, select: { id: true }, take: 1 },
  _count: { select: { messages: true } },
};

const presentRow = (o, now) => ({
  id: o.id,
  orderNumber: o.orderNumber,
  shop: o.shop,
  customer: { name: o.checkout.user.name, phone: o.checkout.user.phone },
  status: o.status,
  lateReason: lateReason(o, now),
  delivery: { method: o.deliveryMethod, fee: o.deliveryFee, ...reservationTimes(o) },
  payment: { method: o.paymentMethod, status: o.paymentStatus },
  total: o.total,
  createdAt: o.createdAt,
  lastStatusAt: o.statusAt,
  openReturn: o.returns.length > 0,
  messageCount: o._count.messages,
});

export async function listOrders(admin, query) {
  const { status, late, page, limit } = query;
  const now = new Date();
  const base = baseWhere(query);
  const where = { AND: [base, ...(status ? [{ status }] : []), ...(late ? [lateWhere(late, now)] : [])] };

  // the summary cards use the same filters except status and late, so they do not change when a card is picked
  const [total, rows, byStatusRows, ...lateCounts] = await Promise.all([
    prisma.subOrder.count({ where }),
    prisma.subOrder.findMany({
      where,
      select: listSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.subOrder.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
    ...LATE_KINDS.map((k) => prisma.subOrder.count({ where: { AND: [base, lateWhere(k, now)] } })),
  ]);

  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const g of byStatusRows) byStatus[g.status] = g._count._all;
  const byLate = Object.fromEntries(LATE_KINDS.map((k, i) => [k, lateCounts[i]]));
  byLate.any = lateCounts.reduce((a, b) => a + b, 0); // the kinds never overlap (one status each)

  // which filters were used, never their values (q can be an email or a phone number)
  const used = Object.keys(query).filter((k) => !['page', 'limit'].includes(k) && query[k] !== undefined);
  await prisma.auditLog.create({
    data: { actorId: admin.id, action: 'order.list_viewed', entityType: 'SubOrder', entityId: 'list', meta: { filters: used } },
  });

  return {
    items: rows.map((r) => presentRow(r, now)),
    counts: { byStatus, byLate },
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

// ---------- detail ----------
const detailInclude = {
  items: true,
  shop: {
    select: {
      id: true, name: true, slug: true, phone: true, whatsapp: true, addressLine: true, shopNumber: true,
      owner: { select: { name: true, email: true, phone: true } },
      market: { select: { name: true, slug: true } },
    },
  },
  checkout: { select: { userId: true, user: { select: { id: true, name: true, email: true, phone: true } } } },
  statusEvents: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
  payments: { orderBy: { createdAt: 'asc' } },
  returns: { orderBy: { createdAt: 'asc' } },
  adminNotes: { orderBy: { createdAt: 'asc' }, include: { author: { select: { id: true, name: true } } } },
  _count: { select: { messages: true } },
};

async function findOrder(orderId) {
  const order = await prisma.subOrder.findUnique({ where: { id: orderId }, include: detailInclude });
  if (!order) throw new AppError(404, NOT_FOUND);
  return order;
}

async function presentDetail(o, now = new Date()) {
  // the actor's name only when the actor is an admin (shop staff and customers stay anonymous here too)
  const actorIds = [...new Set(o.statusEvents.map((e) => e.actorId).filter(Boolean))];
  const admins = actorIds.length
    ? await prisma.user.findMany({ where: { id: { in: actorIds }, role: 'ADMIN' }, select: { id: true, name: true } })
    : [];
  const adminName = new Map(admins.map((a) => [a.id, a.name]));
  const u = o.checkout.user;
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    status: o.status,
    lateReason: lateReason(o, now),
    createdAt: o.createdAt,
    lastStatusAt: o.statusAt,
    completedAt: o.completedAt,
    shopRemindedAt: o.shopRemindedAt,
    delivery: { method: o.deliveryMethod, address: o.deliveryAddress, fee: o.deliveryFee, ...reservationTimes(o) },
    payment: { method: o.paymentMethod, status: o.paymentStatus },
    items: o.items.map((i) => ({
      id: i.id,
      listingId: i.listingId,
      title: i.title,
      unitPrice: i.unitPrice,
      quantity: i.quantity,
      lineTotal: i.unitPrice * i.quantity,
      bargained: i.bargained,
      flashDeal: Boolean(i.flashDealId),
    })),
    subtotal: o.subtotal,
    couponCode: o.couponCode,
    discount: o.discount,
    creditUsed: o.creditUsed,
    total: o.total,
    statusEvents: o.statusEvents.map((e) => ({
      status: e.status,
      note: e.note,
      actorRole: e.actorRole,
      actorName: e.actorRole === 'ADMIN' ? adminName.get(e.actorId) ?? null : null,
      createdAt: e.createdAt,
    })),
    payments: o.payments.map((p) => ({
      id: p.id,
      provider: p.provider,
      providerRef: p.providerRef,
      amount: p.amount,
      status: p.status,
      createdAt: p.createdAt,
      callbackAt: p.callbackAt,
    })),
    returns: o.returns.map((r) => ({
      id: r.id,
      reason: r.reason,
      description: r.description,
      status: r.status,
      resolutionNote: r.resolutionNote,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
    openReturn: o.returns.some((r) => OPEN_RETURN.includes(r.status)),
    messageCount: o._count.messages,
    shop: {
      id: o.shop.id,
      name: o.shop.name,
      slug: o.shop.slug,
      phone: o.shop.phone,
      whatsapp: o.shop.whatsapp,
      addressLine: o.shop.addressLine,
      shopNumber: o.shop.shopNumber,
      market: o.shop.market,
      owner: o.shop.owner,
    },
    customer: { id: u.id, name: u.name, email: u.email, phone: u.phone },
    adminNotes: o.adminNotes.map((n) => ({ id: n.id, body: n.body, author: n.author, createdAt: n.createdAt })),
  };
}

export async function getOrder(admin, orderId) {
  const order = await findOrder(orderId);
  await audit(admin.id, 'order.viewed', orderId);
  return presentDetail(order);
}

// ---------- chat (read only) ----------
export async function getChat(admin, orderId, after) {
  const order = await prisma.subOrder.findUnique({ where: { id: orderId }, select: { id: true } });
  if (!order) throw new AppError(404, NOT_FOUND);
  let since = null;
  if (after) {
    since = await prisma.orderMessage.findFirst({ where: { id: after, subOrderId: orderId }, select: { id: true, createdAt: true } });
  }
  const rows = await prisma.orderMessage.findMany({
    where: {
      subOrderId: orderId,
      ...(since && { OR: [{ createdAt: { gt: since.createdAt } }, { createdAt: since.createdAt, id: { gt: since.id } }] }),
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: CHAT_PAGE,
  });
  await audit(admin.id, 'order.chat_viewed', orderId, { messages: rows.length });
  return {
    readOnly: true,
    messages: rows.map((m) => ({
      id: m.id,
      senderRole: m.senderRole,
      body: m.body, // admins see hidden messages too, marked hidden
      hidden: Boolean(m.isHidden),
      createdAt: m.createdAt,
      readAt: m.readAt,
    })),
  };
}

// ---------- cancel ----------
export async function cancelOrder(admin, orderId, reason) {
  const order = await prisma.subOrder.findUnique({ where: { id: orderId } });
  if (!order) throw new AppError(404, NOT_FOUND);
  if (order.status === 'COMPLETED' || order.status === 'CANCELLED') {
    throw new AppError(409, 'Only an open order can be cancelled', { code: 'ORDER_CLOSED' });
  }
  const refundNeeded = order.paymentMethod === 'ONLINE' && order.paymentStatus === 'PAID';

  await prisma.$transaction(async (tx) => {
    const changed = await tx.subOrder.updateMany({
      where: { id: orderId, status: order.status },
      data: { status: 'CANCELLED', statusAt: new Date() },
    });
    if (changed.count !== 1) throw new AppError(409, 'This order just changed. Refresh and try again.');
    await cancelEffects(tx, order); // stock, deal units, coupon, credit; an ONLINE payment is refunded
    await addEvent(tx, orderId, 'CANCELLED', 'ADMIN', reason, admin.id);
    await audit(admin.id, 'order.cancelled_by_admin', orderId, { from: order.status, to: 'CANCELLED', reason, refundNeeded }, tx);
  });

  // after the commit; neither throws
  await notifyStatusChange(order, 'CANCELLED', reason);
  try {
    await notify(await shopTeamIds(order.shopId), {
      type: 'ORDER_CANCELLED',
      title: `Order ${order.orderNumber} was cancelled by an admin`,
      body: `Reason: ${reason}`,
      data: { orderId: order.id, shopId: order.shopId },
    });
  } catch {
    /* notify is best effort */
  }
  const fresh = await presentDetail(await findOrder(orderId));
  return { ...fresh, refundNeeded };
}

// ---------- notes ----------
export async function addNote(admin, orderId, body) {
  const order = await prisma.subOrder.findUnique({ where: { id: orderId }, select: { id: true } });
  if (!order) throw new AppError(404, NOT_FOUND);
  const note = await prisma.$transaction(async (tx) => {
    const n = await tx.adminOrderNote.create({
      data: { subOrderId: orderId, authorId: admin.id, body },
      include: { author: { select: { id: true, name: true } } },
    });
    await audit(admin.id, 'order.note_added', orderId, { noteId: n.id, length: body.length }, tx);
    return n;
  });
  return { id: note.id, body: note.body, author: note.author, createdAt: note.createdAt };
}

// ---------- remind the shop ----------
export async function remindShop(admin, orderId) {
  const now = new Date();
  const order = await prisma.subOrder.findUnique({ where: { id: orderId } });
  if (!order) throw new AppError(404, NOT_FOUND);
  const reason = lateReason(order, now);
  if (!reason) throw new AppError(409, 'This order is not late', { code: 'ORDER_NOT_LATE' });

  // the guarded update makes "once per hour" hold under concurrent clicks too
  const claimed = await prisma.subOrder.updateMany({
    where: {
      id: orderId,
      OR: [{ shopRemindedAt: null }, { shopRemindedAt: { lte: new Date(now.getTime() - SHOP_REMINDER_EVERY_MS) } }],
    },
    data: { shopRemindedAt: now },
  });
  if (claimed.count !== 1) {
    const last = (await prisma.subOrder.findUnique({ where: { id: orderId }, select: { shopRemindedAt: true } })).shopRemindedAt;
    throw new AppError(429, 'The shop was reminded less than an hour ago', {
      code: 'REMINDER_TOO_SOON',
      retryAt: new Date(last.getTime() + SHOP_REMINDER_EVERY_MS),
    });
  }
  const text = {
    unconfirmed: 'is waiting for your confirmation',
    delivery: 'has been out for delivery for too long',
    pickup: 'has been ready for pickup for too long',
  }[reason];
  const team = await shopTeamIds(order.shopId);
  await notify(team, {
    type: 'ORDER_LATE_REMINDER',
    title: `Order ${order.orderNumber} is late`,
    body: `This order ${text}. Please update it or contact the customer.`,
    data: { orderId: order.id, shopId: order.shopId, lateReason: reason },
  });
  await audit(admin.id, 'order.shop_reminded', orderId, { lateReason: reason, recipients: team.length });
  return { reminded: true, lateReason: reason, recipients: team.length, nextReminderAt: new Date(now.getTime() + SHOP_REMINDER_EVERY_MS) };
}
