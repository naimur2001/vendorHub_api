// Test helper for test-product-sorts.ps1 (never used by the app).
//   node --env-file=.env scripts/product-sorts-test-helper.mjs cleanup <sinceIso> <productId...>
// Deletes the test products and everything they left behind: their listings, the orders of those
// listings (with payments and message log), cart / wishlist rows, analytics events, flash deals,
// notifications and audit entries about them.
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();
const [command, sinceIso, ...productIds] = process.argv.slice(2);
if (command !== 'cleanup' || !sinceIso || productIds.length === 0) {
  console.error('usage: cleanup <sinceIso> <productId...>');
  process.exit(1);
}
const since = new Date(sinceIso);

const listings = await prisma.shopListing.findMany({ where: { productId: { in: productIds } }, select: { id: true } });
const listingIds = listings.map((l) => l.id);
const orders = await prisma.subOrder.findMany({
  where: { items: { some: { listingId: { in: listingIds.length ? listingIds : ['-'] } } } },
  select: { id: true, checkoutId: true },
});
const orderIds = orders.map((o) => o.id);
const checkoutIds = [...new Set(orders.map((o) => o.checkoutId))];
const ids = [...productIds, ...listingIds, ...orderIds];

const out = await prisma.$transaction(async (tx) => {
  const r = {};
  r.notifications = await tx.$executeRaw`
    DELETE FROM "Notification"
    WHERE data->>'orderId' IN (${Prisma.join(ids)}) OR data->>'listingId' IN (${Prisma.join(ids)})
       OR data->>'productId' IN (${Prisma.join(ids)})`;
  r.auditLogs = (await tx.auditLog.deleteMany({ where: { entityId: { in: ids }, createdAt: { gte: since } } })).count;
  r.messageLogs = (await tx.messageLog.deleteMany({ where: { subOrderId: { in: orderIds } } })).count;
  r.payments = (await tx.payment.deleteMany({ where: { subOrderId: { in: orderIds } } })).count;
  r.orders = (await tx.subOrder.deleteMany({ where: { id: { in: orderIds } } })).count; // items, events, chat cascade
  r.checkouts = (await tx.checkoutSession.deleteMany({ where: { id: { in: checkoutIds }, subOrders: { none: {} } } })).count;
  await tx.cartItem.deleteMany({ where: { listingId: { in: listingIds } } });
  await tx.wishlistItem.deleteMany({ where: { listingId: { in: listingIds } } });
  await tx.addToCartEvent.deleteMany({ where: { listingId: { in: listingIds } } });
  await tx.listingView.deleteMany({ where: { listingId: { in: listingIds } } });
  await tx.flashDeal.deleteMany({ where: { listingId: { in: listingIds } } });
  r.listings = (await tx.shopListing.deleteMany({ where: { id: { in: listingIds } } })).count;
  r.products = (await tx.product.deleteMany({ where: { id: { in: productIds } } })).count;
  return r;
});
console.log(JSON.stringify(out));
await prisma.$disconnect();
