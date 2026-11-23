// Test helper for test-admin-orders.ps1 (never used by the app).
//   node --env-file=.env scripts/admin-orders-test-helper.mjs backdate <orderId> <createdHoursAgo> <statusHoursAgo>
//     moves the order's createdAt and statusAt into the past, so the late rules can be tested
//   node --env-file=.env scripts/admin-orders-test-helper.mjs cleanup <sinceIso> <listingId> <orderId...>
//     deletes the test orders and everything they left behind (notifications, audit entries,
//     message log, payments, add-to-cart events of the listing since the test started)
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();
const [command, ...args] = process.argv.slice(2);
const hoursAgo = (h) => new Date(Date.now() - Number(h) * 60 * 60 * 1000);

if (command === 'backdate') {
  const [orderId, createdH, statusH] = args;
  await prisma.subOrder.update({ where: { id: orderId }, data: { createdAt: hoursAgo(createdH), statusAt: hoursAgo(statusH) } });
  console.log(JSON.stringify({ ok: true }));
} else if (command === 'cleanup') {
  const [sinceIso, listingId, ...ids] = args;
  const since = new Date(sinceIso);
  const orders = await prisma.subOrder.findMany({ where: { id: { in: ids } }, select: { id: true, checkoutId: true } });
  const orderIds = orders.map((o) => o.id);
  const checkoutIds = [...new Set(orders.map((o) => o.checkoutId))];
  const out = await prisma.$transaction(async (tx) => {
    const r = {};
    r.notifications = orderIds.length
      ? await tx.$executeRaw`DELETE FROM "Notification" WHERE data->>'orderId' IN (${Prisma.join(orderIds)})`
      : 0;
    r.auditLogs = (
      await tx.auditLog.deleteMany({
        where: {
          OR: [
            { entityType: 'SubOrder', entityId: { in: orderIds } },
            { action: 'order.list_viewed', createdAt: { gte: since } },
          ],
        },
      })
    ).count;
    r.messageLogs = (await tx.messageLog.deleteMany({ where: { subOrderId: { in: orderIds } } })).count;
    r.payments = (await tx.payment.deleteMany({ where: { subOrderId: { in: orderIds } } })).count;
    r.orders = (await tx.subOrder.deleteMany({ where: { id: { in: orderIds } } })).count; // items, events, chat, notes cascade
    r.checkouts = (await tx.checkoutSession.deleteMany({ where: { id: { in: checkoutIds }, subOrders: { none: {} } } })).count;
    r.addToCarts = (await tx.addToCartEvent.deleteMany({ where: { listingId, createdAt: { gte: since } } })).count;
    return r;
  });
  console.log(JSON.stringify(out));
} else {
  console.error('usage: backdate <orderId> <createdHoursAgo> <statusHoursAgo> | cleanup <sinceIso> <listingId> <orderId...>');
  process.exitCode = 1;
}
await prisma.$disconnect();
