// Chat between the customer and the shop about one order.
// Access: the buyer (customer routes) or the shop's own team (shop routes); anyone else gets 404
// for someone else's order (403 for a shop they do not manage). Messages carry only the role,
// never a name, email or phone. The chat closes CHAT_OPEN_DAYS_AFTER_CLOSE days after the order
// is COMPLETED or CANCELLED (reading still works).
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { notify } from '../../lib/notify.js';
import { assertShopTeam } from '../../lib/shopAccess.js';
import { shopTeamIds } from '../notifications/notifications.events.js';
import { CHAT_PAGE, CHAT_OPEN_DAYS_AFTER_CLOSE, CHAT_NOTIFY_EVERY_MS } from '../../config/limits.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOT_FOUND = 'Order not found';
const orderSelect = {
  id: true,
  orderNumber: true,
  shopId: true,
  status: true,
  completedAt: true,
  updatedAt: true,
  checkout: { select: { userId: true } },
  statusEvents: { where: { status: 'CANCELLED' }, orderBy: { createdAt: 'desc' }, take: 1, select: { createdAt: true } },
};

// ---------- who is asking ----------
async function asCustomer(userId, orderId) {
  const order = await prisma.subOrder.findFirst({ where: { id: orderId, checkout: { userId } }, select: orderSelect });
  if (!order) throw new AppError(404, NOT_FOUND);
  return { order, role: 'CUSTOMER' };
}

async function asShop(user, shopId, orderId) {
  await assertShopTeam(user, shopId);
  const order = await prisma.subOrder.findFirst({ where: { id: orderId, shopId }, select: orderSelect });
  if (!order) throw new AppError(404, NOT_FOUND);
  return { order, role: 'SHOP' };
}

const other = (role) => (role === 'CUSTOMER' ? 'SHOP' : 'CUSTOMER');

// When the order closed (COMPLETED or CANCELLED), or null while it is still open.
function closedAt(order) {
  if (order.status === 'COMPLETED') return order.completedAt ?? order.updatedAt;
  if (order.status === 'CANCELLED') return order.statusEvents[0]?.createdAt ?? order.updatedAt;
  return null;
}
const isChatClosed = (order, now = new Date()) => {
  const at = closedAt(order);
  return Boolean(at && now.getTime() - at.getTime() > CHAT_OPEN_DAYS_AFTER_CLOSE * DAY_MS);
};

const present = (role) => (m) => ({
  id: m.id,
  senderRole: m.senderRole,
  mine: m.senderRole === role,
  body: m.body,
  createdAt: m.createdAt,
  readAt: m.readAt,
});

// ---------- reading ----------
// Without `after`: the latest CHAT_PAGE messages. With `after`: the next CHAT_PAGE after that one.
// Always oldest first.
async function list({ order, role }, after) {
  let rows;
  if (after) {
    const pivot = await prisma.orderMessage.findFirst({ where: { id: after, subOrderId: order.id }, select: { createdAt: true, id: true } });
    if (!pivot) throw new AppError(404, 'Message not found');
    rows = await prisma.orderMessage.findMany({
      where: {
        subOrderId: order.id,
        OR: [{ createdAt: { gt: pivot.createdAt } }, { createdAt: pivot.createdAt, id: { gt: pivot.id } }],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: CHAT_PAGE,
    });
  } else {
    rows = (
      await prisma.orderMessage.findMany({
        where: { subOrderId: order.id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: CHAT_PAGE,
      })
    ).reverse();
  }
  const unreadCount = await prisma.orderMessage.count({
    where: { subOrderId: order.id, senderRole: other(role), readAt: null },
  });
  return { messages: rows.map(present(role)), unreadCount, closed: isChatClosed(order) };
}

// ---------- writing ----------
async function send({ order, role }, user, body) {
  if (isChatClosed(order)) {
    throw new AppError(409, `The chat closed ${CHAT_OPEN_DAYS_AFTER_CLOSE} days after the order ended`, { code: 'CHAT_CLOSED' });
  }
  const message = await prisma.orderMessage.create({
    data: { subOrderId: order.id, senderRole: role, senderUserId: user.id, body },
  });
  await notifyOtherSide(order, role); // after the write; never throws
  return present(role)(message);
}

// The other side hears about new messages, at most once per CHAT_NOTIFY_EVERY_MS per order and person.
async function notifyOtherSide(order, role) {
  try {
    const recipients = role === 'CUSTOMER' ? await shopTeamIds(order.shopId) : [order.checkout.userId];
    const since = new Date(Date.now() - CHAT_NOTIFY_EVERY_MS);
    const recent = await prisma.notification.findMany({
      where: {
        userId: { in: recipients },
        type: 'ORDER_MESSAGE',
        createdAt: { gt: since },
        data: { path: ['orderId'], equals: order.id },
      },
      select: { userId: true },
    });
    const told = new Set(recent.map((n) => n.userId));
    await notify(recipients.filter((id) => !told.has(id)), {
      type: 'ORDER_MESSAGE',
      title: role === 'CUSTOMER' ? `New message from the customer (${order.orderNumber})` : `New message from the shop (${order.orderNumber})`,
      body: 'Open the order to read and reply.',
      data: { orderId: order.id, shopId: order.shopId },
    });
  } catch {
    // a notification problem never breaks sending
  }
}

// Marks the OTHER side's messages as read.
async function markRead({ order, role }) {
  const { count } = await prisma.orderMessage.updateMany({
    where: { subOrderId: order.id, senderRole: other(role), readAt: null },
    data: { readAt: new Date() },
  });
  return { marked: count };
}

// ---------- unread counts for order lists ----------
/** Map orderId -> number of unread messages from the other side (for `role` reading). */
export async function unreadCounts(orderIds, role) {
  if (orderIds.length === 0) return new Map();
  const rows = await prisma.orderMessage.groupBy({
    by: ['subOrderId'],
    where: { subOrderId: { in: orderIds }, senderRole: other(role), readAt: null },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.subOrderId, r._count._all]));
}

// ---------- exported per route ----------
export const customerList = async (userId, orderId, after) => list(await asCustomer(userId, orderId), after);
export const customerSend = async (user, orderId, body) => send(await asCustomer(user.id, orderId), user, body);
export const customerRead = async (userId, orderId) => markRead(await asCustomer(userId, orderId));
export const shopList = async (user, shopId, orderId, after) => list(await asShop(user, shopId, orderId), after);
export const shopSend = async (user, shopId, orderId, body) => send(await asShop(user, shopId, orderId), user, body);
export const shopRead = async (user, shopId, orderId) => markRead(await asShop(user, shopId, orderId));
