// Daily subscription job (only while subscriptionsEnabled is on; takes `now` so tests use a fake clock):
//   TRIAL ended           -> ACTIVE when already paid past the trial, else PAST_DUE
//   ACTIVE past its end   -> PAST_DUE (in grace), or CANCELLED + FREE when cancelAtPeriodEnd
//   PAST_DUE past grace   -> EXPIRED; the shop falls back to the FREE plan (data is never deleted)
//   expiring in 7 / 1 days -> one notice each (SUBSCRIPTION_EXPIRING)
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { notify } from '../../lib/notify.js';
import { getSettings } from '../../lib/settings.js';
import { freePlan } from '../../lib/entitlements.js';

const DAY_MS = 24 * 60 * 60 * 1000;

async function toFree(tx, s, status, now) {
  await tx.shopSubscription.update({ where: { id: s.id }, data: { status, isCurrent: false, endedAt: now } });
  const free = await freePlan(tx);
  if (free) {
    await tx.shopSubscription.create({
      data: { shopId: s.shopId, planId: free.id, period: 'MONTHLY', status: 'FREE', startsAt: now, priceAtStart: 0, note: 'Fell back to the free plan' },
    });
  }
  await tx.auditLog.create({ data: { actorId: null, action: `subscription.${status.toLowerCase()}`, entityType: 'ShopSubscription', entityId: s.id, meta: { shopId: s.shopId, by: 'job' } } });
}

const ownerOf = async (shopId) => (await prisma.shop.findUnique({ where: { id: shopId }, select: { ownerId: true, name: true } })) ?? {};

export async function runSubscriptionJob(now = new Date()) {
  const settings = await getSettings();
  const out = { enabled: settings.subscriptionsEnabled, trialsEnded: 0, pastDue: 0, cancelled: 0, expired: 0, expiringNotices: 0 };
  if (!settings.subscriptionsEnabled) return out;
  const told = []; // [shopId, type, title, body]

  for (const s of await prisma.shopSubscription.findMany({ where: { isCurrent: true, status: 'TRIAL', trialEndsAt: { lte: now } } })) {
    const status = s.currentPeriodEnd && s.currentPeriodEnd > now ? 'ACTIVE' : 'PAST_DUE';
    const done = await prisma.shopSubscription.updateMany({ where: { id: s.id, status: 'TRIAL' }, data: { status } });
    if (done.count) {
      out.trialsEnded++;
      if (status === 'PAST_DUE') told.push([s.shopId, 'SUBSCRIPTION_PAST_DUE', 'Your free trial has ended', `Pay within ${settings.graceDays} days to keep your plan.`]);
    }
  }

  for (const s of await prisma.shopSubscription.findMany({ where: { isCurrent: true, status: 'ACTIVE', priceAtStart: { gt: 0 }, currentPeriodEnd: { lte: now } } })) {
    if (s.cancelAtPeriodEnd) {
      await prisma.$transaction((tx) => toFree(tx, s, 'CANCELLED', now));
      out.cancelled++;
      told.push([s.shopId, 'SUBSCRIPTION_EXPIRED', 'Your plan has ended', 'Your shop is on the free plan now.']);
    } else {
      const done = await prisma.shopSubscription.updateMany({ where: { id: s.id, status: 'ACTIVE' }, data: { status: 'PAST_DUE' } });
      if (done.count) {
        out.pastDue++;
        told.push([s.shopId, 'SUBSCRIPTION_PAST_DUE', 'Your plan payment is due', `Pay within ${settings.graceDays} days to keep your plan.`]);
      }
    }
  }

  const graceEnd = new Date(now.getTime() - settings.graceDays * DAY_MS);
  for (const s of await prisma.shopSubscription.findMany({ where: { isCurrent: true, status: 'PAST_DUE', currentPeriodEnd: { lte: graceEnd } } })) {
    await prisma.$transaction((tx) => toFree(tx, s, 'EXPIRED', now));
    out.expired++;
    told.push([s.shopId, 'SUBSCRIPTION_EXPIRED', 'Your plan has expired', 'Your shop is on the free plan now. Nothing was deleted.']);
  }

  const soon = await prisma.shopSubscription.findMany({
    where: { isCurrent: true, status: { in: ['TRIAL', 'ACTIVE'] }, priceAtStart: { gt: 0 }, currentPeriodEnd: { gt: now, lte: new Date(now.getTime() + 7 * DAY_MS) } },
  });
  for (const s of soon) {
    const days = s.currentPeriodEnd - now <= DAY_MS ? 1 : 7;
    if (s.expiryNoticeDays !== null && s.expiryNoticeDays <= days) continue; // already told
    const done = await prisma.shopSubscription.updateMany({ where: { id: s.id, expiryNoticeDays: s.expiryNoticeDays }, data: { expiryNoticeDays: days } });
    if (done.count) {
      out.expiringNotices++;
      told.push([s.shopId, 'SUBSCRIPTION_EXPIRING', days === 1 ? 'Your plan ends tomorrow' : 'Your plan ends in 7 days', 'Pay in time to keep your plan.']);
    }
  }

  for (const [shopId, type, title, body] of told) {
    const shop = await ownerOf(shopId);
    await notify([shop.ownerId], { type, title, body, data: { shopId } });
  }
  return out;
}

export const runSubscriptionSweep = () =>
  runSubscriptionJob()
    .then((r) => r.enabled && (r.pastDue || r.expired || r.cancelled || r.trialsEnded || r.expiringNotices) && logger.info(r, 'subscription job'))
    .catch((err) => logger.error(err, 'subscription job failed'));
