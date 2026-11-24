import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { assertShopAccess } from '../../lib/shopAccess.js';
import { deriveAvailability, stockIsFine } from '../../lib/availability.js';
import { getOrder as getCustomerOrder, statusEventsInclude, reservationTimes } from '../checkout/checkout.service.js';
import { notifyStatusChange, notifyCustomerCancel } from '../notifications/notifications.events.js';
import { unreadCounts } from '../orderChat/orderChat.service.js';
import { releasePromotions } from '../promotions/promotions.service.js';
import { rewardReferralIfDue, notifyReferralReward } from '../referrals/referrals.service.js';
import { refundPayments } from '../payments/payments.service.js';
import { shipmentInclude, forShop } from '../delivery/shipments.present.js';
import { autoBook } from '../delivery/shipments.service.js';

// Which statuses an order may move to from each status.
const TRANSITIONS = {
  PLACED: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['READY_FOR_PICKUP', 'OUT_FOR_DELIVERY', 'CANCELLED'],
  READY_FOR_PICKUP: ['COMPLETED', 'CANCELLED'],
  OUT_FOR_DELIVERY: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

const orderInclude = {
  items: true,
  checkout: { select: { userId: true, user: { select: { name: true, phone: true } } } },
  shipment: { include: shipmentInclude },
};

// Courier orders (a shipment exists): the shop marks them READY_FOR_PICKUP (that books the courier);
// from then on the courier drives the status (webhook / polling), and a booked one is cancelled by admins.
function courierNext(order) {
  if (order.status === 'CONFIRMED') return ['READY_FOR_PICKUP', 'CANCELLED'];
  if (order.status === 'READY_FOR_PICKUP') return ['PENDING', 'CANCELLED'].includes(order.shipment.status) ? ['CANCELLED'] : [];
  if (order.status === 'PLACED') return TRANSITIONS.PLACED;
  return [];
}

// The statuses this order may move to right now (also tells the UI which buttons to show).
function allowedNext(order) {
  if (order.shipment) {
    return courierNext(order).filter((next) => next !== 'CONFIRMED' || order.paymentMethod !== 'ONLINE' || order.paymentStatus === 'PAID');
  }
  return TRANSITIONS[order.status].filter((next) => {
    if (next === 'READY_FOR_PICKUP') return order.deliveryMethod !== 'VENDOR_DELIVERY'; // STORE_PICKUP or RESERVE_PICKUP
    if (next === 'OUT_FOR_DELIVERY') return order.deliveryMethod === 'VENDOR_DELIVERY';
    if (next === 'CONFIRMED') return order.paymentMethod !== 'ONLINE' || order.paymentStatus === 'PAID';
    return true;
  });
}

const formatForShop = (o) => ({
  id: o.id,
  orderNumber: o.orderNumber,
  status: o.status,
  paymentMethod: o.paymentMethod,
  paymentStatus: o.paymentStatus,
  deliveryMethod: o.deliveryMethod,
  deliveryAddress: o.deliveryAddress,
  deliveryFee: o.deliveryFee,
  subtotal: o.subtotal,
  discount: o.discount,
  couponCode: o.couponCode,
  creditUsed: o.creditUsed,
  total: o.total,
  createdAt: o.createdAt,
  ...reservationTimes(o),
  customer: { name: o.checkout.user.name, phone: o.checkout.user.phone },
  items: o.items.map((i) => ({
    id: i.id,
    title: i.title,
    unitPrice: i.unitPrice,
    quantity: i.quantity,
    lineTotal: i.unitPrice * i.quantity,
    bargained: i.bargained,
  })),
  nextStatuses: allowedNext(o),
  // courier orders only (else null): no courier cost, no margin
  shipment: forShop(o.shipment),
});

// Puts the stock of a cancelled order back and re-derives the public availability.
export async function restock(tx, orderId) {
  const items = await tx.orderItem.findMany({ where: { subOrderId: orderId } });
  for (const item of items) {
    const listing = await tx.shopListing.findUnique({
      where: { id: item.listingId },
      select: { stockQty: true },
    });
    if (listing.stockQty === null) continue; // the shop does not track a number for this listing
    const updated = await tx.shopListing.update({
      where: { id: item.listingId },
      data: { stockQty: { increment: item.quantity } },
    });
    await tx.shopListing.update({
      where: { id: item.listingId },
      data: {
        availability: deriveAvailability(updated.stockQty),
        // back above the low-stock threshold: the next low stock may notify again
        ...(updated.lowStockNotifiedAt && stockIsFine(updated) && { lowStockNotifiedAt: null }),
      },
    });
  }
}

// Everything that must happen when an order is cancelled (mock refund until a real gateway exists).
export async function cancelEffects(tx, order) {
  await restock(tx, order.id);
  // a courier shipment that was never booked goes with the order (a booked one is cancelled by admins)
  await tx.shipment.updateMany({ where: { subOrderId: order.id, status: 'PENDING' }, data: { status: 'CANCELLED', statusAt: new Date(), nextAttemptAt: null } });
  await releasePromotions(tx, order.id); // flash-deal units and the coupon use come back
  if (order.paymentMethod === 'ONLINE' && order.paymentStatus === 'PAID') {
    await refundPayments(await tx.payment.findMany({ where: { subOrderId: order.id, status: 'PAID' } })); // the provider first
    await tx.subOrder.update({ where: { id: order.id }, data: { paymentStatus: 'REFUNDED' } });
    await tx.payment.updateMany({
      where: { subOrderId: order.id, status: 'PAID' },
      data: { status: 'REFUNDED' },
    });
  }
}

const logChange = (tx, actorId, action, orderId, from, to, reason) =>
  tx.auditLog.create({
    data: {
      actorId,
      action,
      entityType: 'SubOrder',
      entityId: orderId,
      meta: { from, to, ...(reason && { reason }) },
    },
  });

export async function listShopOrders(user, shopId, { status, paymentStatus, page, limit }) {
  await assertShopAccess(user, shopId);
  const where = { shopId, ...(status && { status }), ...(paymentStatus && { paymentStatus }) };
  const [total, rows] = await Promise.all([
    prisma.subOrder.count({ where }),
    prisma.subOrder.findMany({
      where,
      include: orderInclude,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);
  const unread = await unreadCounts(rows.map((r) => r.id), 'SHOP'); // unread chat messages from customers
  return {
    items: rows.map((r) => ({ ...formatForShop(r), unreadCount: unread.get(r.id) ?? 0 })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getShopOrder(user, shopId, orderId) {
  await assertShopAccess(user, shopId);
  const order = await prisma.subOrder.findFirst({
    where: { id: orderId, shopId },
    include: { ...orderInclude, statusEvents: statusEventsInclude },
  });
  if (!order) throw new AppError(404, 'Order not found');
  return { ...formatForShop(order), statusEvents: order.statusEvents };
}

// One timeline row, written in the same transaction as the status change.
// actorRole: CUSTOMER | SHOP | ADMIN | SYSTEM; actorId is shown (as a name) only in the admin order view.
export const addEvent = (tx, subOrderId, status, actorRole, note, actorId = null) =>
  tx.orderStatusEvent.create({
    data: { subOrderId, status, actorRole, actorId, note: note || null },
  });

// An admin using the shop order endpoints acts as ADMIN, not as the shop.
const shopSideRole = (user) => (user.role === 'ADMIN' ? 'ADMIN' : 'SHOP');

export async function changeStatus(user, shopId, orderId, { status, reason }) {
  await assertShopAccess(user, shopId);
  const order = await prisma.subOrder.findFirst({
    where: { id: orderId, shopId },
    include: orderInclude,
  });
  if (!order) throw new AppError(404, 'Order not found');

  if (order.shipment) {
    if (['OUT_FOR_DELIVERY', 'COMPLETED'].includes(status)) {
      throw new AppError(409, 'The courier updates this order. It changes when the courier picks it up and delivers it', { code: 'COURIER_MANAGED' });
    }
    if (status === 'CANCELLED' && !['PENDING', 'CANCELLED'].includes(order.shipment.status)) {
      throw new AppError(409, 'The courier is already booked. Ask Vendors Hub to cancel the shipment first', { code: 'SHIPMENT_BOOKED' });
    }
  }
  if (!TRANSITIONS[order.status].includes(status)) {
    throw new AppError(409, `An order that is ${order.status} cannot move to ${status}`);
  }
  if (status === 'READY_FOR_PICKUP' && order.deliveryMethod === 'VENDOR_DELIVERY' && !order.shipment) {
    throw new AppError(409, 'Only pickup orders can be marked ready for pickup');
  }
  if (status === 'OUT_FOR_DELIVERY' && order.deliveryMethod !== 'VENDOR_DELIVERY') {
    throw new AppError(409, 'Only delivery orders can be marked out for delivery');
  }
  if (status === 'CONFIRMED' && order.paymentMethod === 'ONLINE' && order.paymentStatus !== 'PAID') {
    throw new AppError(409, 'Waiting for the online payment');
  }

  let referralReward = null;
  await prisma.$transaction(async (tx) => {
    const changed = await tx.subOrder.updateMany({
      where: { id: orderId, status: order.status },
      data: { status, statusAt: new Date() },
    });
    if (changed.count !== 1) {
      throw new AppError(409, 'This order just changed. Refresh and try again.');
    }
    if (status === 'CANCELLED') await cancelEffects(tx, order);
   
        // the moment of completion starts the return window
    if (status === 'COMPLETED') {
      await tx.subOrder.update({ where: { id: orderId }, data: { completedAt: new Date() } });
      // the customer's first completed order pays a pending referral (both sides, once)
      referralReward = await rewardReferralIfDue(tx, order.checkout.userId);
    }
    // cash is collected when the customer receives the goods
    if (status === 'COMPLETED' && order.paymentMethod !== 'ONLINE') {
      await tx.subOrder.update({ where: { id: orderId }, data: { paymentStatus: 'PAID' } });
    }
    // the guarded update above means the status really changed (same status is never a transition)
    await addEvent(tx, orderId, status, shopSideRole(user), status === 'CANCELLED' ? reason : null, user.id);
    await logChange(tx, user.id, 'order.status_changed', orderId, order.status, status, reason);
  });
  await notifyStatusChange(order, status, reason); // after the commit, never throws
  await notifyReferralReward(referralReward);
  if (status === 'READY_FOR_PICKUP' && order.shipment) await autoBook(orderId); // never throws; a failure is retried
  return getShopOrder(user, shopId, orderId);
}

// The customer may cancel only before the shop confirms the order.
export async function cancelByCustomer(userId, orderId, reason) {
  const order = await prisma.subOrder.findFirst({
    where: { id: orderId, checkout: { userId } },
    include: orderInclude,
  });
  if (!order) throw new AppError(404, 'Order not found');
  if (order.status !== 'PLACED') {
    throw new AppError(409, 'An order can only be cancelled before the shop confirms it');
  }

  await prisma.$transaction(async (tx) => {
    const changed = await tx.subOrder.updateMany({
      where: { id: orderId, status: 'PLACED' },
      data: { status: 'CANCELLED', statusAt: new Date() },
    });
    if (changed.count !== 1) {
      throw new AppError(409, 'This order just changed. Refresh and try again.');
    }
    await cancelEffects(tx, order);
    await addEvent(tx, orderId, 'CANCELLED', 'CUSTOMER', reason, userId);
    await logChange(tx, userId, 'order.cancelled_by_customer', orderId, 'PLACED', 'CANCELLED', reason);
  });
  await notifyCustomerCancel(order, reason); // after the commit, never throws
  return getCustomerOrder(userId, orderId);
}