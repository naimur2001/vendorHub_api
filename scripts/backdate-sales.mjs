// Usage: node --env-file=.env scripts/backdate-sales.mjs <listingId> <days>
// Test helper: pretends every order and add-to-cart of one listing happened <days> days ago,
// so the 7-day window of GET /products?sort=trending can be tested.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const [listingId, days] = process.argv.slice(2);
const when = new Date(Date.now() - Number(days) * 24 * 60 * 60 * 1000);
const day = new Date(`${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(when)}T00:00:00Z`);

const orders = await prisma.subOrder.updateMany({
  where: { items: { some: { listingId } } },
  data: { createdAt: when },
});
const carts = await prisma.addToCartEvent.updateMany({ where: { listingId }, data: { createdAt: when, day } });
await prisma.$disconnect();
console.log(JSON.stringify({ orders: orders.count, addToCarts: carts.count, days: Number(days) }));
