// DEVELOPMENT TOOL for test-moderation.ps1: gives a user <count> reports made today (on made-up
// review ids), so the daily report limit can be tested. --clean removes them again.
// Usage: node --env-file=.env scripts/fill-flags.mjs <email> <count> | --clean <email>
import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const NOTE = 'fill-flags test row';
try {
  const clean = process.argv[2] === '--clean';
  const email = clean ? process.argv[3] : process.argv[2];
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  await prisma.contentFlag.deleteMany({ where: { reporterId: user.id, note: NOTE } });
  if (!clean) {
    const count = Number(process.argv[3]);
    if (!Number.isInteger(count) || count < 0) throw new Error('Usage: fill-flags.mjs <email> <count>');
    await prisma.contentFlag.createMany({
      data: Array.from({ length: count }, () => ({ targetType: 'REVIEW', targetId: crypto.randomUUID(), reporterId: user.id, reason: 'SPAM', note: NOTE })),
    });
  }
  console.log(clean ? 'cleaned' : `filled ${process.argv[3]}`);
} finally {
  await prisma.$disconnect();
}
