import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { assertShopAccess } from '../../lib/shopAccess.js';
import { restock } from '../fulfilment/fulfilment.service.js';

const DAY = 24 * 60 * 60 * 1000;

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
  actions: { respond: (role === 'SHOP' || role === 'ADMIN') && r.status === 'REQUESTED' },
});

// Mock refund until a real gateway exists. A paid online order is refunded online, a paid cash order
// in cash at the shop; both are recorded as REFUNDED. Stock comes back only if the shop says so.
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
    await tx.auditLog.create({
      data: {
        actorId: user.id,
        action: 'return.requested',
        entityType: 'ReturnRequest',
        entityId: r.id,
        meta: { orderId, reason },
      },
    });
    return r;
  });
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

// ---------- everyone involved ----------

export async function getReturn(user, id) {
  const r = await prisma.returnRequest.findUnique({ where: { id }, include: returnInclude });
  const role = r ? await viewerRole(user, r) : null;
  if (!role) throw new AppError(404, 'Return request not found');
  return present(r, role);
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
    await tx.auditLog.create({
      data: {
        actorId: user.id,
        action: decision === 'APPROVE' ? 'return.approved' : 'return.rejected',
        entityType: 'ReturnRequest',
        entityId: id,
        meta: { note: note ?? null, ...(decision === 'APPROVE' && { restock: putBack }) },
      },
    });
  });
  return getReturn(user, id);
}