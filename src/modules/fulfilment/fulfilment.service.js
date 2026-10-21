import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { assertShopAccess } from '../../lib/shopAccess.js';
import { deriveAvailability } from '../../lib/availability.js';
import { getOrder as getCustomerOrder } from '../checkout/checkout.service.js';

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
  checkout: { select: { user: { select: { name: true, phone: true } } } },
};

// The statuses this order may move to right now (also tells the UI which buttons to show).
function allowedNext(order) {
  return TRANSITIONS[order.status].filter((next) => {
    if (next === 'READY_FOR_PICKUP') return order.deliveryMethod === 'STORE_PICKUP';
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
  total: o.total,
  createdAt: o.createdAt,
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
});

// Puts the stock of a cancelled order back and re-derives the public availability.
async function restock(tx, orderId) {
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
      data: { availability: deriveAvailability(updated.stockQty) },
    });
  }
}

// Everything that must happen when an order is cancelled (mock refund until a real gateway exists).
async function cancelEffects(tx, order) {
  await restock(tx, order.id);
  if (order.paymentMethod === 'ONLINE' && order.paymentStatus === 'PAID') {
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
  return {
    items: rows.map(formatForShop),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getShopOrder(user, shopId, orderId) {
  await assertShopAccess(user, shopId);
  const order = await prisma.subOrder.findFirst({
    where: { id: orderId, shopId },
    include: orderInclude,
  });
  if (!order) throw new AppError(404, 'Order not found');
  return formatForShop(order);
}

export async function changeStatus(user, shopId, orderId, { status, reason }) {
  await assertShopAccess(user, shopId);
  const order = await prisma.subOrder.findFirst({
    where: { id: orderId, shopId },
    include: orderInclude,
  });
  if (!order) throw new AppError(404, 'Order not found');

  if (!TRANSITIONS[order.status].includes(status)) {
    throw new AppError(409, `An order that is ${order.status} cannot move to ${status}`);
  }
  if (status === 'READY_FOR_PICKUP' && order.deliveryMethod !== 'STORE_PICKUP') {
    throw new AppError(409, 'Only pickup orders can be marked ready for pickup');
  }
  if (status === 'OUT_FOR_DELIVERY' && order.deliveryMethod !== 'VENDOR_DELIVERY') {
    throw new AppError(409, 'Only delivery orders can be marked out for delivery');
  }
  if (status === 'CONFIRMED' && order.paymentMethod === 'ONLINE' && order.paymentStatus !== 'PAID') {
    throw new AppError(409, 'Waiting for the online payment');
  }

  await prisma.$transaction(async (tx) => {
    const changed = await tx.subOrder.updateMany({
      where: { id: orderId, status: order.status },
      data: { status },
    });
    if (changed.count !== 1) {
      throw new AppError(409, 'This order just changed. Refresh and try again.');
    }
    if (status === 'CANCELLED') await cancelEffects(tx, order);
    // cash is collected when the customer receives the goods
    if (status === 'COMPLETED' && order.paymentMethod !== 'ONLINE') {
      await tx.subOrder.update({ where: { id: orderId }, data: { paymentStatus: 'PAID' } });
    }
    await logChange(tx, user.id, 'order.status_changed', orderId, order.status, status, reason);
  });
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
      data: { status: 'CANCELLED' },
    });
    if (changed.count !== 1) {
      throw new AppError(409, 'This order just changed. Refresh and try again.');
    }
    await cancelEffects(tx, order);
    await logChange(tx, userId, 'order.cancelled_by_customer', orderId, 'PLACED', 'CANCELLED', reason);
  });
  return getCustomerOrder(userId, orderId);
}