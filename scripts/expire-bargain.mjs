// Usage: node --env-file=.env scripts/expire-bargain.mjs <bargainId>
// Moves a negotiation's deadline into the past so expiry can be tested without waiting.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const id = process.argv[2];
await prisma.bargain.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });
await prisma.$disconnect();
console.log('expired', id);