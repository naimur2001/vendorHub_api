// Test helper for test-featured-targets.ps1 (never used by the app).
//   delete-product <productId>                 deletes a test product and its listings (its slot keeps pointing at it)
//   cleanup <sinceIso> <entityId...>           deletes the audit entries and notifications the test caused for these ids
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();
const [command, ...args] = process.argv.slice(2);
if (command === 'delete-product') {
  const [id] = args;
  await prisma.$transaction([
    prisma.shopListing.deleteMany({ where: { productId: id } }),
    prisma.product.delete({ where: { id } }),
  ]);
  console.log(JSON.stringify({ deleted: id }));
} else if (command === 'cleanup') {
  const [sinceIso, ...ids] = args;
  const since = new Date(sinceIso);
  const r = await prisma.auditLog.deleteMany({ where: { entityId: { in: ids }, createdAt: { gte: since } } });
  const n = await prisma.$executeRaw`
    DELETE FROM "Notification" WHERE "createdAt" >= ${since} AND data->>'productId' IN (${Prisma.join(ids)})`;
  console.log(JSON.stringify({ auditLogs: r.count, notifications: n }));
} else {
  console.error('usage: delete-product <productId> | cleanup <sinceIso> <entityId...>');
  process.exitCode = 1;
}
await prisma.$disconnect();
