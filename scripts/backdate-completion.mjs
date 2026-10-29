// Usage: node --env-file=.env scripts/backdate-completion.mjs <orderId> <days>
// Pretends the order was completed <days> days ago, so the return window can be tested.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const [orderId, days] = process.argv.slice(2);
await prisma.subOrder.update({
  where: { id: orderId },
  data: { completedAt: new Date(Date.now() - Number(days) * 24 * 60 * 60 * 1000) },
});
await prisma.$disconnect();
console.log(`order ${orderId} now completed ${days} days ago`);