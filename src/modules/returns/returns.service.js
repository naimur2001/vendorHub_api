import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { assertShopAccess } from '../../lib/shopAccess.js';
import { restock } from '../fulfilment/fulfilment.service.js';
import { notifyReturn } from '../notifications/notifications.events.js';

const DAY = 24 * 60 * 60 * 1000;
// A return is "open" while someone still has to act on it. Messages are allowed only then.
const OPEN = ['REQUESTED', 'REJECTED', 'ESCALATED'];

const returnInclude = {
  subOrder: {
    select: {
      id: true,
      orderNumber: true,
      shopId: true,
      total: true,
      paymentMethod: true,
      paymentStatus: true,
      completedAt: true,
      updatedAt: true,
      shop: { select: { id: true, name: true, slug: true } },
    },
  },
  customer: { select: { id: true, name: true } },
  messages: { orderBy: { createdAt: 'asc' }, include: { author: { select: { name: true } } } },
};

// Is this user the owner or a staff member of the shop (or an admin)?
async function isShopTeam(user, shopId) {
  if (user.role === 'ADMIN') return true;
  const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { ownerId: true } });
  if (!shop) return false;
  if (shop.ownerId === user.id) return true;
  const staff = await prisma.shopStaff.findUnique({ where: { shopId_userId: { shopId, userId: user.id } } });
  return Boolean(staff);
}

// How the viewer relates to this return: CUSTOMER, ADMIN, SHOP, or null (no access).
async function viewerRole(user, r) {
  if (r.customerId === user.id) return 'CUSTOMER';
  if (user.role === 'ADMIN') return 'ADMIN';
  if (await isShopTeam(user, r.subOrder.shopId)) return 'SHOP';
  return null;
}

const present = (r, role) => ({
  id: r.id,
  status: r.status,
  reason: r.reason,
  description: r.description,
  resolutionNote: r.resolutionNote,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  order: {
    id: r.subOrder.id,
    orderNumber: r.subOrder.orderNumber,
    total: r.subOrder.total,
    paymentMethod: r.subOrder.paymentMethod,
    paymentStatus: r.subOrder.paymentStatus,
    completedAt: r.subOrder.completedAt ?? r.subOrder.updatedAt,
  },
  shop: r.subOrder.shop,
  customer: { name: r.customer.name },
  messages: r.messages.map((m) => ({
    id: m.id,
    authorRole: m.authorRole,
    author: m.author.name,
    body: m.body,
    createdAt: m.createdAt,
  })),
  // which buttons the UI should show for this viewer
  actions: {
    respond: (role === 'SHOP' || role === 'ADMIN') && r.status === 'REQUESTED',
    escalate: role === 'CUSTOMER' && r.status === 'REJECTED',
    resolve: role === 'ADMIN' && r.status === 'ESCALATED',
    message: OPEN.includes(r.status),
  },
});

const audit = (tx, actorId, action, id, meta) =>
  tx.auditLog.create({ data: { actorId, action, entityType: 'ReturnRequest', entityId: id, meta } });

// Mock refund until a real gateway exists. A paid online order is refunded online, a paid cash order
// in cash at the shop; both are recorded as REFUNDED. Stock comes back only if asked.
async function refund(tx, order, putBack) {
  if (order.paymentStatus === 'PAID') {
    await tx.subOrder.update({ where: { id: order.id }, data: { paymentStatus: 'REFUNDED' } });
    await tx.payment.updateMany({
      where: { subOrderId: order.id, status: 'PAID' },
      data: { status: 'REFUNDED' },
    });
  }
  if (putBack) await restock(tx, order.id);
}

// ---------- customer ----------

export async function createReturn(user, orderId, { reason, description }) {
  const order = await prisma.subOrder.findFirst({
    where: { id: orderId, checkout: { userId: user.id } },
    include: { shop: { select: { returnWindowDays: true } } },
  });
  if (!order) throw new AppError(404, 'Order not found');
  if (order.status !== 'COMPLETED') {
    throw new AppError(409, 'A return can be requested only for a completed order');
  }
  const days = order.shop.returnWindowDays;
  if (days === 0) throw new AppError(409, 'This shop does not accept returns');
  const completedAt = order.completedAt ?? order.updatedAt; // orders completed before completedAt existed
  if (Date.now() > completedAt.getTime() + days * DAY) {
    throw new AppError(409, `The return window of ${days} days has passed`);
  }

  const created = await prisma.$transaction(async (tx) => {
    // lock the order row: two simultaneous requests for the same order wait for each other
    await tx.$queryRaw`SELECT id FROM "SubOrder" WHERE id = ${orderId} FOR UPDATE`;
    const existing = await tx.returnRequest.findFirst({ where: { subOrderId: orderId }, select: { id: true } });
    if (existing) {
      throw new AppError(409, 'A return was already requested for this order', { returnId: existing.id });
    }
    const r = await tx.returnRequest.create({
      data: { subOrderId: orderId, customerId: user.id, reason, description },
    });
    await audit(tx, user.id, 'return.requested', r.id, { orderId, reason });
    return r;
  });
  await notifyReturn(created.id, 'requested', user.id); // after the commit, never throws
  return getReturn(user, created.id);
}

export async function listMine(user, { status, orderId, page, limit }) {
  const where = { customerId: user.id, ...(status && { status }), ...(orderId && { subOrderId: orderId }) };
  const [total, rows] = await Promise.all([
    prisma.returnRequest.count({ where }),
    prisma.returnRequest.findMany({
      where,
      include: returnInclude,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);
  return {
    items: rows.map((r) => present(r, 'CUSTOMER')),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

// Only the customer, and only after the shop said no.
export async function escalate(user, id, { reason }) {
  const r = await prisma.returnRequest.findUnique({ where: { id }, select: { customerId: true, status: true } });
  if (!r || r.customerId !== user.id) throw new AppError(404, 'Return request not found');
  if (r.status !== 'REJECTED') {
    throw new AppError(409, 'A return can be escalated only after the shop has rejected it');
  }

  await prisma.$transaction(async (tx) => {
    const changed = await tx.returnRequest.updateMany({
      where: { id, status: 'REJECTED' },
      data: { status: 'ESCALATED' },
    });
    if (changed.count !== 1) throw new AppError(409, 'This return just changed. Refresh and try again.');
    await tx.returnMessage.create({ data: { returnId: id, authorId: user.id, authorRole: 'CUSTOMER', body: reason } });
    await audit(tx, user.id, 'return.escalated', id, { reason });
  });
  await notifyReturn(id, 'escalated', user.id);
  return getReturn(user, id);
}

// ---------- everyone involved ----------

export async function getReturn(user, id) {
  const r = await prisma.returnRequest.findUnique({ where: { id }, include: returnInclude });
  const role = r ? await viewerRole(user, r) : null;
  if (!role) throw new AppError(404, 'Return request not found');
  return present(r, role);
}

// Customer, shop team or admin can write while the return is open.
export async function addMessage(user, id, { body }) {
  const r = await prisma.returnRequest.findUnique({
    where: { id },
    select: { customerId: true, status: true, subOrder: { select: { shopId: true } } },
  });
  const role = r ? await viewerRole(user, r) : null;
  if (!role) throw new AppError(404, 'Return request not found');
  if (!OPEN.includes(r.status)) throw new AppError(409, `This return is ${r.status} and closed for messages`);

  await prisma.returnMessage.create({ data: { returnId: id, authorId: user.id, authorRole: role, body } });
  await notifyReturn(id, 'message', user.id);
  return getReturn(user, id);
}

// ---------- shop ----------

export async function listForShop(user, shopId, { status, page, limit }) {
  await assertShopAccess(user, shopId);
  const where = { subOrder: { shopId }, ...(status && { status }) };
  const [total, rows] = await Promise.all([
    prisma.returnRequest.count({ where }),
    prisma.returnRequest.findMany({
      where,
      include: returnInclude,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);
  const role = user.role === 'ADMIN' ? 'ADMIN' : 'SHOP';
  return {
    items: rows.map((r) => present(r, role)),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function respond(user, id, { decision, note, restock: putBack }) {
  const r = await prisma.returnRequest.findUnique({ where: { id }, include: { subOrder: true } });
  if (!r || !(await isShopTeam(user, r.subOrder.shopId))) throw new AppError(404, 'Return request not found');
  if (r.status !== 'REQUESTED') throw new AppError(409, `This return is ${r.status} and cannot be answered`);

  const next = decision === 'APPROVE' ? 'REFUNDED' : 'REJECTED';
  await prisma.$transaction(async (tx) => {
    // conditional update: if two people answer at once, only the first one wins
    const changed = await tx.returnRequest.updateMany({
      where: { id, status: 'REQUESTED' },
      data: { status: next, resolutionNote: note ?? null, resolvedById: user.id },
    });
    if (changed.count !== 1) throw new AppError(409, 'This return just changed. Refresh and try again.');
    if (decision === 'APPROVE') await refund(tx, r.subOrder, putBack);
    // the note also joins the thread, so the full story stays readable after later decisions
    if (note) {
      await tx.returnMessage.create({
        data: { returnId: id, authorId: user.id, authorRole: user.role === 'ADMIN' ? 'ADMIN' : 'SHOP', body: note },
      });
    }
    await audit(tx, user.id, decision === 'APPROVE' ? 'return.approved' : 'return.rejected', id, {
      note: note ?? null,
      ...(decision === 'APPROVE' && { restock: putBack }),
    });
  });
  await notifyReturn(id, decision === 'APPROVE' ? 'approved' : 'rejected', user.id);
  return getReturn(user, id);
}

// ---------- admin ----------

// The dispute queue: by default the escalated returns, longest waiting first.
export async function listDisputes({ status, page, limit }) {
  const where = status === 'ALL' ? {} : { status: status ?? 'ESCALATED' };
  const [total, rows] = await Promise.all([
    prisma.returnRequest.count({ where }),
    prisma.returnRequest.findMany({
      where,
      include: returnInclude,
      orderBy: { updatedAt: 'asc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);
  return {
    items: rows.map((r) => present(r, 'ADMIN')),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

// The final decision: APPROVE refunds (restock optional), REJECT closes.
export async function resolve(admin, id, { decision, note, restock: putBack }) {
  const r = await prisma.returnRequest.findUnique({ where: { id }, include: { subOrder: true } });
  if (!r) throw new AppError(404, 'Return request not found');
  if (r.status !== 'ESCALATED') {
    throw new AppError(409, `Only an escalated return can be resolved (this one is ${r.status})`);
  }

  const next = decision === 'APPROVE' ? 'REFUNDED' : 'CLOSED';
  await prisma.$transaction(async (tx) => {
    const changed = await tx.returnRequest.updateMany({
      where: { id, status: 'ESCALATED' },
      data: { status: next, resolutionNote: note, resolvedById: admin.id },
    });
    if (changed.count !== 1) throw new AppError(409, 'This return just changed. Refresh and try again.');
    if (decision === 'APPROVE') await refund(tx, r.subOrder, putBack);
    await tx.returnMessage.create({ data: { returnId: id, authorId: admin.id, authorRole: 'ADMIN', body: note } });
    await audit(tx, admin.id, 'return.resolved', id, {
      decision,
      note,
      ...(decision === 'APPROVE' && { restock: putBack }),
    });
  });
  await notifyReturn(id, 'resolved', admin.id);
  return getReturn(admin, id);
}