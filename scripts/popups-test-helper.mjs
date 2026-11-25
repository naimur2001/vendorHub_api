// Test helper for test-popups.ps1 (never used by the app).
//   live                  how many popups are live now (the suite needs 0 to start)
//   cleanup <sinceIso>    deletes the popup audit entries made since then (the suite deletes its popups itself)
import { prisma } from '../src/lib/prisma.js';

const [command, ...args] = process.argv.slice(2);
let out;
if (command === 'live') {
  const now = new Date();
  out = {
    live: await prisma.sitePopup.count({
      where: { isActive: true, AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gt: now } }] }] },
    }),
  };
} else if (command === 'cleanup') {
  const since = new Date(args[0]);
  const a = await prisma.auditLog.deleteMany({
    where: { createdAt: { gte: since }, OR: [{ entityType: 'SitePopup' }, { entityType: 'PlatformSetting', entityId: 'popups' }] },
  });
  out = { auditLogs: a.count };
} else {
  console.error('usage: live | cleanup <sinceIso>');
  process.exitCode = 1;
}
await prisma.$disconnect();
if (out) console.log(JSON.stringify(out));
