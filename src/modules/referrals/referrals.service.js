// Referrals and store credit.
// A customer shares their referralCode. A new customer who signs up with it gets a PENDING referral;
// when that new customer's FIRST order is COMPLETED, both get REFERRAL_CREDIT taka (CreditLedger).
// Self-referral is refused: the same phone, or a device both accounts used (X-Device-Id, stored only
// as a keyed hash). It is checked at signup and again when the reward is due.
// Credit pays at most CREDIT_MAX_SHARE of an order's items (after a coupon), on the server only.
import crypto from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { notify } from '../../lib/notify.js';
import { env } from '../../config/env.js';
import { REFERRAL_CREDIT, CREDIT_MAX_SHARE } from '../../config/limits.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
const DEVICE_ID = /^[A-Za-z0-9_-]{8,128}$/;

// ---------- devices ----------
/** A keyed hash of the web app's device id header, or null when it is missing or malformed. */
export function deviceHashOf(req) {
  const id = req.get('x-device-id');
  if (!id || !DEVICE_ID.test(id)) return null;
  return crypto.createHmac('sha256', env.JWT_ACCESS_SECRET).update(`device|${id}`).digest('hex');
}

export async function recordDevice(userId, deviceHash) {
  if (!deviceHash) return;
  await prisma.userDevice
    .upsert({ where: { userId_deviceHash: { userId, deviceHash } }, update: {}, create: { userId, deviceHash } })
    .catch(() => {}); // best effort
}

// ---------- codes ----------
const newCode = () => Array.from(crypto.randomBytes(8), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');

export async function ensureReferralCode(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { referralCode: true } });
  if (user.referralCode) return user.referralCode;
  for (let i = 0; i < 5; i++) {
    try {
      const u = await prisma.user.update({ where: { id: userId }, data: { referralCode: newCode() }, select: { referralCode: true } });
      return u.referralCode;
    } catch (err) {
      if (err.code !== 'P2002') throw err; // taken: try another
    }
  }
  throw new AppError(500, 'Could not create a referral code');
}

// The abuse checks, shared by signup and reward time. Returns a fixed reason or null.
async function selfReferralReason(db, referrerId, refereeId) {
  if (referrerId === refereeId) return 'Own code';
  const [a, b] = await Promise.all([
    db.user.findUnique({ where: { id: referrerId }, select: { phone: true } }),
    db.user.findUnique({ where: { id: refereeId }, select: { phone: true } }),
  ]);
  if (a?.phone && b?.phone && a.phone === b.phone) return 'Same phone';
  const shared = await db.userDevice.count({
    where: { userId: refereeId, deviceHash: { in: (await db.userDevice.findMany({ where: { userId: referrerId }, select: { deviceHash: true } })).map((d) => d.deviceHash) } },
  });
  if (shared) return 'Same device';
  return null;
}

/** At signup: link the new customer to the referrer. Never blocks the signup. */
export async function applyReferralAtSignup(refereeId, code) {
  if (!code) return { applied: false };
  const referrer = await prisma.user.findUnique({ where: { referralCode: code }, select: { id: true, role: true, isActive: true } });
  if (!referrer || !referrer.isActive || referrer.role !== 'CUSTOMER') return { applied: false, reason: 'Unknown code' };
  const reason = await selfReferralReason(prisma, referrer.id, refereeId);
  await prisma.referral.create({
    data: { referrerId: referrer.id, refereeId, status: reason ? 'REJECTED' : 'PENDING', reason },
  });
  return { applied: !reason, ...(reason && { reason }) };
}

/**
 * Inside the transaction that marks an order COMPLETED: the referee's first completed order pays
 * both sides once. Returns { referrerId, refereeId } when rewarded (to notify after the commit).
 */
export async function rewardReferralIfDue(tx, refereeId) {
  const referral = await tx.referral.findUnique({ where: { refereeId } });
  if (!referral || referral.status !== 'PENDING') return null;
  const completed = await tx.subOrder.count({ where: { checkout: { userId: refereeId }, status: 'COMPLETED' } });
  if (completed !== 1) return null; // only the FIRST completed order
  const reason = await selfReferralReason(tx, referral.referrerId, refereeId);
  if (reason) {
    await tx.referral.update({ where: { id: referral.id }, data: { status: 'REJECTED', reason } });
    return null;
  }
  const claimed = await tx.referral.updateMany({ where: { id: referral.id, status: 'PENDING' }, data: { status: 'REWARDED', rewardedAt: new Date() } });
  if (claimed.count !== 1) return null;
  await tx.creditLedger.createMany({
    data: [
      { userId: referral.referrerId, amount: REFERRAL_CREDIT, kind: 'REFERRAL_REWARD', referralId: referral.id, note: 'A friend you invited completed their first order' },
      { userId: refereeId, amount: REFERRAL_CREDIT, kind: 'REFERRAL_REWARD', referralId: referral.id, note: 'Welcome reward: your first order is completed' },
    ],
  });
  return { referrerId: referral.referrerId, refereeId };
}

export async function notifyReferralReward(r) {
  if (!r) return;
  await notify([r.referrerId, r.refereeId], {
    type: 'CREDIT_REWARD',
    title: `You got ${REFERRAL_CREDIT} taka credit`,
    body: 'It is used automatically at checkout when you choose to use credit (up to 20% of an order).',
    data: { amount: REFERRAL_CREDIT },
  });
}

// ---------- spending at checkout ----------
export const balanceOf = async (db, userId) => (await db.creditLedger.aggregate({ where: { userId }, _sum: { amount: true } }))._sum.amount ?? 0;

/** The most credit one order may use: CREDIT_MAX_SHARE of its items after the coupon (rounded down). */
export const creditCap = (itemsAfterDiscount) => Math.floor(itemsAfterDiscount * CREDIT_MAX_SHARE);

// A cancelled order gives its credit back (once).
export async function refundCredit(tx, orderId) {
  const spend = await tx.creditLedger.findUnique({ where: { subOrderId_kind: { subOrderId: orderId, kind: 'CHECKOUT_SPEND' } } });
  if (!spend) return;
  const refunded = await tx.creditLedger.findUnique({ where: { subOrderId_kind: { subOrderId: orderId, kind: 'CHECKOUT_REFUND' } } });
  if (refunded) return;
  await tx.creditLedger.create({
    data: { userId: spend.userId, amount: -spend.amount, kind: 'CHECKOUT_REFUND', subOrderId: orderId, note: 'Order cancelled: credit returned' },
  });
}

// ---------- GET /me/credit ----------
export async function myCredit(userId) {
  const [code, balance, history, invited, rewarded] = await Promise.all([
    ensureReferralCode(userId),
    balanceOf(prisma, userId),
    prisma.creditLedger.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.referral.count({ where: { referrerId: userId } }),
    prisma.referral.count({ where: { referrerId: userId, status: 'REWARDED' } }),
  ]);
  return {
    balance,
    referralCode: code,
    rewardPerReferral: REFERRAL_CREDIT,
    maxSharePerOrder: CREDIT_MAX_SHARE,
    referrals: { invited, rewarded },
    history: history.map((e) => ({ amount: e.amount, kind: e.kind, note: e.note, orderId: e.subOrderId, createdAt: e.createdAt })),
  };
}
