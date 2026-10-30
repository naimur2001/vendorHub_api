// Usage: node --env-file=.env scripts/expire-reset-token.mjs <email>
// Moves the deadline of the user's unused reset links into the past, so expiry can be tested.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const user = await prisma.user.findUnique({ where: { email: process.argv[2] } });
await prisma.passwordResetToken.updateMany({
  where: { userId: user.id, usedAt: null },
  data: { expiresAt: new Date(Date.now() - 1000) },
});
await prisma.$disconnect();
console.log('expired the reset links of', process.argv[2]);