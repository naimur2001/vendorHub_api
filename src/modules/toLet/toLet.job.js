// Shop To-Let daily job: reminds owners TOLET_REMIND_DAYS before a listing expires, and expires it.
// Safe to run twice: every listing is claimed with a guarded update first.
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { TOLET_REMIND_DAYS } from '../../config/limits.js';
import { DAY_MS, notifyOwner } from './toLet.shared.js';

export async function sweepToLet(now = new Date()) {
  const soon = new Date(now.getTime() + TOLET_REMIND_DAYS * DAY_MS);
  const due = await prisma.toLetListing.findMany({
    where: { status: 'PUBLISHED', expiryRemindedAt: null, expiresAt: { gt: now, lte: soon } },
    take: 500,
  });
  let reminded = 0;
  for (const l of due) {
    const claimed = await prisma.toLetListing.updateMany({ where: { id: l.id, expiryRemindedAt: null }, data: { expiryRemindedAt: now } });
    if (claimed.count !== 1) continue;
    reminded += 1;
    await notifyOwner(l, {
      type: 'TOLET_EXPIRING',
      title: 'Your listing ends soon',
      body: `It ends on ${l.expiresAt.toISOString().slice(0, 10)}. Reply to us if you want it renewed.`,
      sms: true,
    });
  }
  const expired = await prisma.toLetListing.updateMany({ where: { status: 'PUBLISHED', expiresAt: { lte: now } }, data: { status: 'EXPIRED' } });
  if (expired.count) {
    await prisma.auditLog.create({ data: { actorId: null, action: 'tolet.expired', entityType: 'ToLetListing', entityId: 'sweep', meta: { count: expired.count } } });
  }
  return { reminded, expired: expired.count };
}

export const runToLetSweep = () =>
  sweepToLet()
    .then((r) => (r.reminded || r.expired) && logger.info(r, 'to-let sweep'))
    .catch((err) => logger.error(err, 'to-let sweep failed'));
