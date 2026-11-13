// Account deletion jobs: the 7-day reminder (once) and the anonymisation of accounts whose date has come.
// One transaction per user; files are deleted only after the database update. No personal data in logs or audit.
import path from 'node:path';
import crypto from 'node:crypto';
import { unlink } from 'node:fs/promises';
import bcrypt from 'bcryptjs';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { sendMail } from '../../lib/mailer.js';

const DAY = 24 * 60 * 60 * 1000;
const PRIVATE_DIR = path.resolve(env.UPLOAD_DIR, 'private');

// "Road 5, Dhanmondi, Dhaka. Phone: 017..." -> "Dhanmondi, Dhaka": only area + city, no phone numbers.
export function reduceAddress(text) {
  if (!text) return null;
  const withoutPhone = text.split(/\.?\s*phone\s*:/i)[0].replace(/(\+?88)?0?1\d{9}/g, '').trim();
  const parts = withoutPhone.split(',').map((p) => p.replace(/[.\s]+$/, '').trim()).filter(Boolean);
  return parts.length ? parts.slice(-2).join(', ') : null;
}

async function anonymiseUser(userId) {
  const files = await prisma.fileUpload.findMany({ where: { ownerId: userId, purpose: 'PRIVATE_DOCUMENT' }, select: { storedName: true } });
  const checkoutIds = (await prisma.checkoutSession.findMany({ where: { userId }, select: { id: true } })).map((c) => c.id);
  const orders = checkoutIds.length
    ? await prisma.subOrder.findMany({ where: { checkoutId: { in: checkoutIds }, deliveryAddress: { not: null } }, select: { id: true, deliveryAddress: true } })
    : [];
  const unusableHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10); // nobody knows this password

  await prisma.$transaction(async (tx) => {
    await tx.address.deleteMany({ where: { userId } });
    await tx.notification.deleteMany({ where: { userId } });
    await tx.shopFollow.deleteMany({ where: { userId } });
    await tx.cart.deleteMany({ where: { userId } }); // cart items go with the cart
    await tx.refreshToken.deleteMany({ where: { userId } });
    await tx.passwordResetToken.deleteMany({ where: { userId } });
    await tx.emailVerificationToken.deleteMany({ where: { userId } });
    await tx.idempotencyKey.deleteMany({ where: { userId } }); // stored checkout answers contain addresses
    await tx.fileUpload.deleteMany({ where: { ownerId: userId, purpose: 'PRIVATE_DOCUMENT' } });
    await tx.review.updateMany({ where: { userId }, data: { comment: null } }); // ratings stay; author becomes "Deleted user"
    for (const o of orders) {
      // orders are kept (shops need their history); only area + city remain, never the phone
      await tx.subOrder.update({ where: { id: o.id }, data: { deliveryAddress: reduceAddress(o.deliveryAddress) } });
    }
    await tx.user.update({
      where: { id: userId },
      data: {
        name: 'Deleted user',
        email: `deleted-${userId}@deleted.invalid`,
        phone: null,
        avatarUrl: null,
        passwordHash: unusableHash,
        isActive: false,
        emailVerifiedAt: null,
        deletionScheduledFor: null,
        deletionReason: null,
      },
    });
    await tx.auditLog.create({ data: { actorId: null, action: 'user.deleted', entityType: 'User', entityId: userId, meta: {} } });
  });

  // the verification documents on disk, only after the database no longer points at them
  for (const f of files) {
    await unlink(path.join(PRIVATE_DIR, f.storedName)).catch(() => {});
  }
}

// Once per account, 7 days (or less) before the date.
async function sendReminders(now) {
  const soon = await prisma.user.findMany({
    where: { deletionScheduledFor: { gt: now, lte: new Date(now.getTime() + 7 * DAY) }, deletionReminderSentAt: null },
    select: { id: true, name: true, email: true, deletionScheduledFor: true },
  });
  let sent = 0;
  for (const u of soon) {
    // conditional: two job runs at the same time never send twice
    const claimed = await prisma.user.updateMany({ where: { id: u.id, deletionReminderSentAt: null }, data: { deletionReminderSentAt: now } });
    if (claimed.count === 0 || !u.email) continue;
    try {
      await sendMail({
        to: u.email,
        subject: 'Your Vendors Hub account will be deleted soon',
        text: [
          `Hello ${u.name},`,
          '',
          `Your Vendors Hub account will be deleted on ${u.deletionScheduledFor.toISOString().slice(0, 10)}.`,
          'To keep it, log in before that date and choose "Cancel deletion" in your account:',
          `${env.APP_URL}/account`,
        ].join('\n'),
      });
      sent += 1;
    } catch (err) {
      logger.error({ err: err.message, userId: u.id }, 'deletion reminder could not be sent');
    }
  }
  return sent;
}

export async function runAccountDeletionJobs(now = new Date()) {
  const reminders = await sendReminders(now);
  const due = await prisma.user.findMany({ where: { deletionScheduledFor: { lte: now } }, select: { id: true } });
  let anonymised = 0;
  for (const { id } of due) {
    try {
      await anonymiseUser(id);
      anonymised += 1;
    } catch (err) {
      logger.error({ err: err.message, userId: id }, 'account anonymisation failed (will retry next run)');
    }
  }
  return { reminders, due: due.length, anonymised };
}