// Account deletion with a grace period: the account is disabled now and anonymised later (job in step 3).
// During the grace period the user can still log in, see the state and cancel.
import bcrypt from 'bcryptjs';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { env } from '../../config/env.js';
import { sendMail } from '../../lib/mailer.js';
import { logger } from '../../lib/logger.js';

const OPEN_ORDER = ['PLACED', 'CONFIRMED', 'READY_FOR_PICKUP', 'OUT_FOR_DELIVERY'];
const OPEN_RETURN = ['REQUESTED', 'REJECTED', 'ESCALATED']; // REJECTED can still be escalated
const LIVE_BARGAIN = ['AWAITING_SHOP', 'COUNTERED'];

const day = (d) => d.toISOString().slice(0, 10);

// Never throws: a mail problem must not undo or block the request.
async function tell(user, subject, text) {
  if (!user.email) return;
  try {
    await sendMail({ to: user.email, subject, text });
  } catch (err) {
    logger.error({ err: err.message, userId: user.id }, 'deletion email could not be sent');
  }
}

// Things that must be finished first: open orders and returns, as customer and as shop owner.
async function findBlockers(userId, shopIds) {
  const checkoutIds = (await prisma.checkoutSession.findMany({ where: { userId }, select: { id: true } })).map((c) => c.id);
  const [myOrders, myReturns, shopOrders, shopReturns] = await Promise.all([
    checkoutIds.length ? prisma.subOrder.count({ where: { checkoutId: { in: checkoutIds }, status: { in: OPEN_ORDER } } }) : 0,
    prisma.returnRequest.count({ where: { customerId: userId, status: { in: OPEN_RETURN } } }),
    shopIds.length ? prisma.subOrder.count({ where: { shopId: { in: shopIds }, status: { in: OPEN_ORDER } } }) : 0,
    shopIds.length ? prisma.returnRequest.count({ where: { subOrder: { shopId: { in: shopIds } }, status: { in: OPEN_RETURN } } }) : 0,
  ]);
  return [
    { code: 'OPEN_ORDERS', count: myOrders, message: 'Your orders that are not completed or cancelled yet' },
    { code: 'OPEN_RETURNS', count: myReturns, message: 'Your return requests that are still open' },
    { code: 'SHOP_OPEN_ORDERS', count: shopOrders, message: 'Open orders in your shops' },
    { code: 'SHOP_OPEN_RETURNS', count: shopReturns, message: 'Open return requests in your shops' },
  ].filter((b) => b.count > 0);
}

export async function requestDeletion(userId, { password, reason }) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError(404, 'User not found');
  if (user.role === 'ADMIN') throw new AppError(403, 'Admin accounts cannot be deleted this way');
  // the same bcrypt work as login, so the answer time does not depend on what went wrong
  if (!(await bcrypt.compare(password, user.passwordHash))) throw new AppError(400, 'The password is not correct');

  const ownedShops = await prisma.shop.findMany({ where: { ownerId: userId }, select: { id: true, isActive: true } });
  const shopIds = ownedShops.map((s) => s.id);
  const blockers = await findBlockers(userId, shopIds);
  if (blockers.length) throw new AppError(409, 'Please finish these first, then delete your account', { blockers });

  const now = new Date();
  const scheduledFor = new Date(now.getTime() + env.ACCOUNT_DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000);
  const toHide = ownedShops.filter((s) => s.isActive).map((s) => s.id);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { deletionRequestedAt: now, deletionScheduledFor: scheduledFor, deletionReason: reason ?? null, deletionReminderSentAt: null },
    });
    await tx.refreshToken.deleteMany({ where: { userId } }); // logged out everywhere
    if (toHide.length) {
      // remember which shops WE hid, so a cancel only brings those back
      await tx.shop.updateMany({ where: { id: { in: toHide } }, data: { isActive: false, hiddenForOwnerDeletion: true } });
    }
    await tx.shopStaff.deleteMany({ where: { userId } });
    const cart = await tx.cart.findUnique({ where: { userId }, select: { id: true } });
    if (cart) await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
    // live bargains are simply closed: as customer, and on the listings of the user's shops
    await tx.bargain.updateMany({
      where: { status: { in: LIVE_BARGAIN }, OR: [{ customerId: userId }, ...(shopIds.length ? [{ listing: { shopId: { in: shopIds } } }] : [])] },
      data: { status: 'DECLINED' },
    });
    await tx.auditLog.create({
      data: {
        actorId: userId,
        action: 'user.deletion_requested',
        entityType: 'User',
        entityId: userId,
        meta: { scheduledFor: scheduledFor.toISOString(), hiddenShops: toHide.length },
      },
    });
  });

  await tell(
    user,
    'Your Vendors Hub account will be deleted',
    [
      `Hello ${user.name},`,
      '',
      `We received your request to delete your Vendors Hub account. It is now disabled and will be deleted on ${day(scheduledFor)}.`,
      'Changed your mind? Log in before that date and choose "Cancel deletion" in your account:',
      `${env.APP_URL}/account`,
      '',
      'If you did not ask for this, log in and cancel it, and change your password.',
    ].join('\n'),
  );
  return { deletionScheduledFor: scheduledFor.toISOString() };
}

export async function cancelDeletion(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError(404, 'User not found');
  if (!user.deletionScheduledFor) throw new AppError(409, 'Your account is not scheduled for deletion');

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { deletionRequestedAt: null, deletionScheduledFor: null, deletionReason: null, deletionReminderSentAt: null },
    });
    // only the shops that were active before the request (never one an admin switched off)
    await tx.shop.updateMany({
      where: { ownerId: userId, hiddenForOwnerDeletion: true },
      data: { isActive: true, hiddenForOwnerDeletion: false },
    });
    await tx.auditLog.create({ data: { actorId: userId, action: 'user.deletion_cancelled', entityType: 'User', entityId: userId, meta: {} } });
  });

  await tell(
    user,
    'Your Vendors Hub account is restored',
    [`Hello ${user.name},`, '', 'Your account deletion was cancelled. Your account and your shops are active again.'].join('\n'),
  );
  return { cancelled: true };
}