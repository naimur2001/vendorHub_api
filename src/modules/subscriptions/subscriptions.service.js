// Shop subscriptions (admin managed; shop side hidden while subscriptionsEnabled is false).
// currentPeriodEnd = paid (or trial) until. A new paid subscription starts unpaid (currentPeriodEnd =
// startsAt); each recorded payment moves currentPeriodEnd forward by one period. FREE rows have none.
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { notify } from '../../lib/notify.js';
import { getSettings, saveSettings, clearSettingsCache } from '../../lib/settings.js';
import { MODULES, LIMITS, FREE_SHOP_PHOTOS, entitlementsOf, usageOf, currentSubscription, freePlan } from '../../lib/entitlements.js';
import { assertShopAccess } from '../../lib/shopAccess.js';

export const MONTHS = { MONTHLY: 1, QUARTERLY: 3, HALF_YEARLY: 6, YEARLY: 12 };
const DAY_MS = 24 * 60 * 60 * 1000;
const PAYING = ['ACTIVE', 'PAST_DUE'];

const audit = (tx, actorId, action, entityType, entityId, meta) =>
  tx.auditLog.create({ data: { actorId, action, entityType, entityId, meta } });

/** date + n months (UTC), clamped to the last day of the target month (Jan 31 + 1 = Feb 28/29). */
export function addMonths(date, n) {
  const d = new Date(date);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), last));
  return target;
}
const addDays = (date, n) => new Date(new Date(date).getTime() + n * DAY_MS);

// ---------- settings ----------

export const getSubscriptionSettings = async () => {
  const s = await getSettings();
  return { subscriptionsEnabled: s.subscriptionsEnabled, freeTrialDays: s.freeTrialDays, graceDays: s.graceDays };
};

export async function updateSubscriptionSettings(admin, input) {
  try {
    await prisma.$transaction(async (tx) => {
      const changed = await saveSettings(tx, admin.id, input);
      await audit(tx, admin.id, 'settings.updated', 'PlatformSetting', 'subscriptions', changed);
    });
  } finally {
    clearSettingsCache();
  }
  return getSubscriptionSettings();
}

// ---------- plans ----------

/** Prices by period length with the saving against paying monthly (null without a monthly price). */
function presentPrices(prices, { activeOnly = false } = {}) {
  const list = prices.filter((p) => !activeOnly || p.isActive).sort((a, b) => MONTHS[a.period] - MONTHS[b.period]);
  const monthly = list.find((p) => p.period === 'MONTHLY' && p.isActive)?.amount ?? null;
  return list.map((p) => {
    const months = MONTHS[p.period];
    const full = monthly === null ? null : monthly * months;
    const saving = full === null ? null : full - p.amount;
    return {
      period: p.period,
      months,
      amount: p.amount,
      isActive: p.isActive,
      monthlyEquivalent: Math.round(p.amount / months),
      savingVsMonthly: saving,
      savingPercent: full ? Math.round((saving / full) * 1000) / 10 : null,
    };
  });
}

export const presentPlan = (p, opts) => ({
  id: p.id,
  code: p.code,
  nameEn: p.nameEn,
  nameBn: p.nameBn,
  descriptionEn: p.descriptionEn,
  descriptionBn: p.descriptionBn,
  modules: MODULES.filter((m) => p.modules.includes(m)),
  maxProducts: p.maxProducts,
  maxStaff: p.maxStaff,
  maxActiveDeals: p.maxActiveDeals,
  isPublished: p.isPublished,
  isActive: p.isActive,
  sortOrder: p.sortOrder,
  prices: presentPrices(p.prices ?? [], opts),
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
});

const planOrder = [{ sortOrder: 'asc' }, { createdAt: 'asc' }];

export async function listPlans() {
  const plans = await prisma.subscriptionPlan.findMany({ include: { prices: true, _count: { select: { subscriptions: { where: { isCurrent: true } } } } }, orderBy: planOrder });
  return plans.map((p) => ({ ...presentPlan(p), currentShops: p._count.subscriptions }));
}

async function loadPlan(id) {
  const p = await prisma.subscriptionPlan.findUnique({ where: { id }, include: { prices: true } });
  if (!p) throw new AppError(404, 'Plan not found');
  return p;
}

export async function createPlan(admin, input) {
  try {
    return await prisma.$transaction(async (tx) => {
      const p = await tx.subscriptionPlan.create({ data: input, include: { prices: true } });
      await audit(tx, admin.id, 'subscription.plan_created', 'SubscriptionPlan', p.id, { code: p.code });
      return presentPlan(p);
    });
  } catch (err) {
    if (err.code === 'P2002') throw new AppError(409, 'A plan with this code already exists', { code: 'PLAN_CODE_TAKEN' });
    throw err;
  }
}

export async function updatePlan(admin, id, input) {
  const p = await loadPlan(id);
  if (p.code === 'FREE' && ((input.code && input.code !== 'FREE') || input.isActive === false)) {
    throw new AppError(409, 'The FREE plan is the fallback: it keeps its code and stays active', { code: 'FREE_PLAN' });
  }
  try {
    return await prisma.$transaction(async (tx) => {
      const u = await tx.subscriptionPlan.update({ where: { id }, data: input, include: { prices: true } });
      await audit(tx, admin.id, 'subscription.plan_updated', 'SubscriptionPlan', id, input);
      return presentPlan(u);
    });
  } catch (err) {
    if (err.code === 'P2002') throw new AppError(409, 'A plan with this code already exists', { code: 'PLAN_CODE_TAKEN' });
    throw err;
  }
}

export async function deletePlan(admin, id) {
  const p = await loadPlan(id);
  if (p.code === 'FREE') throw new AppError(409, 'The FREE plan is the fallback and cannot be deleted', { code: 'FREE_PLAN' });
  const [subs, reqs] = await Promise.all([
    prisma.shopSubscription.count({ where: { planId: id } }),
    prisma.subscriptionRequest.count({ where: { planId: id } }),
  ]);
  if (subs || reqs) throw new AppError(409, 'Shops have used this plan: switch it off instead', { code: 'PLAN_IN_USE' });
  await prisma.$transaction(async (tx) => {
    await tx.subscriptionPlan.delete({ where: { id } });
    await audit(tx, admin.id, 'subscription.plan_deleted', 'SubscriptionPlan', id, { code: p.code });
  });
}

/** PUT: the plan's prices become exactly this list (periods left out are removed). */
export async function setPrices(admin, id, { prices }) {
  await loadPlan(id);
  await prisma.$transaction(async (tx) => {
    await tx.planPrice.deleteMany({ where: { planId: id, period: { notIn: prices.map((p) => p.period) } } });
    for (const p of prices) {
      await tx.planPrice.upsert({
        where: { planId_period: { planId: id, period: p.period } },
        update: { amount: p.amount, isActive: p.isActive },
        create: { planId: id, ...p },
      });
    }
    await audit(tx, admin.id, 'subscription.prices_set', 'SubscriptionPlan', id, { prices });
  });
  return presentPlan(await loadPlan(id));
}

// ---------- subscriptions ----------

/** A per-shop custom price first, else the plan's active price for the period; null when none. */
async function priceFor(db, shopId, planId, period) {
  const custom = await db.shopPlanPrice.findUnique({ where: { shopId_planId_period: { shopId, planId, period } } });
  if (custom) return custom.amount;
  const p = await db.planPrice.findUnique({ where: { planId_period: { planId, period } } });
  return p && p.isActive ? p.amount : null;
}

const paidThisPeriod = (s, now = new Date()) => {
  if (s.priceAtStart === 0 || s.status === 'FREE') return true;
  if (!s.currentPeriodEnd) return false;
  if (s.status === 'TRIAL') return s.trialEndsAt ? s.currentPeriodEnd > s.trialEndsAt : false;
  return s.currentPeriodEnd > now;
};

const subInclude = {
  plan: { select: { id: true, code: true, nameEn: true, nameBn: true } },
  shop: { select: { id: true, name: true, slug: true, owner: { select: { name: true, email: true } } } },
  payments: { where: { status: 'RECORDED' }, orderBy: { paidAt: 'desc' }, take: 1, select: { paidAt: true } },
};

function presentSub(s) {
  const paid = paidThisPeriod(s);
  return {
    id: s.id,
    shop: s.shop,
    plan: s.plan,
    period: s.period,
    status: s.status,
    startsAt: s.startsAt,
    currentPeriodEnd: s.currentPeriodEnd,
    trialEndsAt: s.trialEndsAt,
    cancelAtPeriodEnd: s.cancelAtPeriodEnd,
    priceAtStart: s.priceAtStart,
    source: s.source,
    note: s.note,
    isCurrent: s.isCurrent,
    endedAt: s.endedAt,
    lastPaymentAt: s.payments?.[0]?.paidAt ?? null,
    paidThisPeriod: paid,
    amountDue: paid ? 0 : s.priceAtStart,
    createdAt: s.createdAt,
  };
}

const loadSub = async (id, db = prisma) => {
  const s = await db.shopSubscription.findUnique({ where: { id }, include: subInclude });
  if (!s) throw new AppError(404, 'Subscription not found');
  return s;
};

/** Inside tx: the shop falls back to the FREE plan (data is never deleted). */
async function fallbackToFree(tx, shopId, now) {
  const free = await freePlan(tx);
  if (!free) return null;
  return tx.shopSubscription.create({
    data: { shopId, planId: free.id, period: 'MONTHLY', status: 'FREE', startsAt: now, priceAtStart: 0, source: 'ADMIN', note: 'Fell back to the free plan' },
  });
}

/** Inside tx: ends the shop's current row (history kept). */
async function endCurrent(tx, shopId, status, now) {
  await tx.shopSubscription.updateMany({ where: { shopId, isCurrent: true }, data: { isCurrent: false, endedAt: now, status } });
}

/** Starts (or changes to) a plan. Used by the admin and by approving a request. */
export async function startSubscription(admin, shopId, { planId, period, startsAt, trialDays, note }, { source = 'ADMIN', tx: outer } = {}) {
  const work = async (tx) => {
    const shop = await tx.shop.findUnique({ where: { id: shopId }, select: { id: true } });
    if (!shop) throw new AppError(404, 'Shop not found');
    const plan = await tx.subscriptionPlan.findUnique({ where: { id: planId } });
    if (!plan) throw new AppError(404, 'Plan not found');
    if (!plan.isActive) throw new AppError(400, 'This plan is switched off', { code: 'PLAN_INACTIVE' });
    const price = await priceFor(tx, shopId, planId, period);
    if (price === null) throw new AppError(400, 'This plan has no active price for that period', { code: 'PRICE_NOT_SET' });

    const now = new Date();
    const start = startsAt ?? now;
    const trial = trialDays && trialDays > 0 ? addDays(start, trialDays) : null;
    const status = trial ? 'TRIAL' : price === 0 ? 'FREE' : 'ACTIVE';
    await endCurrent(tx, shopId, 'CANCELLED', now);
    const s = await tx.shopSubscription.create({
      data: {
        shopId,
        planId,
        period,
        status,
        startsAt: start,
        trialEndsAt: trial,
        currentPeriodEnd: trial ?? (price === 0 ? null : start), // a paid plan starts unpaid
        priceAtStart: price,
        source,
        note: note ?? null,
      },
    });
    await audit(tx, admin.id, 'subscription.started', 'ShopSubscription', s.id, { shopId, plan: plan.code, period, status, price, source });
    return s.id;
  };
  try {
    const id = outer ? await work(outer) : await prisma.$transaction(work);
    return outer ? id : presentSub(await loadSub(id));
  } catch (err) {
    if (err.code === 'P2002') throw new AppError(409, 'The shop subscription changed at the same time. Try again', { code: 'SUBSCRIPTION_BUSY' });
    throw err;
  }
}

export async function listSubscriptions({ status, planId, period, q, expiringInDays, unpaid, history, page, limit }) {
  const now = new Date();
  const and = [];
  if (!history) and.push({ isCurrent: true });
  if (status) and.push({ status });
  if (planId) and.push({ planId });
  if (period) and.push({ period });
  if (q) and.push({ shop: { OR: [{ name: { contains: q, mode: 'insensitive' } }, { slug: { contains: q.toLowerCase() } }] } });
  if (expiringInDays) and.push({ status: { in: ['TRIAL', 'ACTIVE'] }, currentPeriodEnd: { gt: now, lte: addDays(now, expiringInDays) } });
  if (unpaid) and.push({ status: { in: PAYING }, priceAtStart: { gt: 0 }, currentPeriodEnd: { lte: now } });
  const where = { AND: and };
  const [total, rows] = await Promise.all([
    prisma.shopSubscription.count({ where }),
    prisma.shopSubscription.findMany({ where, include: subInclude, orderBy: [{ currentPeriodEnd: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }], skip: (page - 1) * limit, take: limit }),
  ]);
  return { items: rows.map(presentSub), pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

export async function getSubscription(id) {
  const s = await loadSub(id);
  const payments = await prisma.subscriptionPayment.findMany({ where: { subscriptionId: id }, orderBy: { paidAt: 'desc' } });
  return { ...presentSub(s), payments };
}

async function loadCurrent(tx, id) {
  const s = await tx.shopSubscription.findUnique({ where: { id } });
  if (!s) throw new AppError(404, 'Subscription not found');
  if (!s.isCurrent) throw new AppError(409, 'This subscription has ended', { code: 'SUBSCRIPTION_ENDED' });
  return s;
}

export async function updateSubscription(admin, id, input) {
  await prisma.$transaction(async (tx) => {
    const s = await loadCurrent(tx, id);
    const now = new Date();
    const data = {};
    if (input.note !== undefined) data.note = input.note;
    if (input.cancelAtPeriodEnd !== undefined) data.cancelAtPeriodEnd = input.cancelAtPeriodEnd;
    if (input.extendDays) {
      data.currentPeriodEnd = addDays(s.currentPeriodEnd ?? now, input.extendDays);
      if (s.status === 'TRIAL' && s.trialEndsAt) data.trialEndsAt = addDays(s.trialEndsAt, input.extendDays);
      data.expiryNoticeDays = null;
    }
    if (input.status === 'CANCELLED' || input.status === 'EXPIRED') {
      await tx.shopSubscription.update({ where: { id }, data: { ...data, status: input.status, isCurrent: false, endedAt: now } });
      await fallbackToFree(tx, s.shopId, now);
    } else {
      if (input.status) data.status = input.status;
      await tx.shopSubscription.update({ where: { id }, data });
    }
    await audit(tx, admin.id, 'subscription.updated', 'ShopSubscription', id, input);
  });
  return presentSub(await loadSub(id));
}

export async function recordPayment(admin, id, { amount, method, reference, paidAt }) {
  if (method === 'ONLINE') throw new AppError(400, 'Online payment is not connected yet', { code: 'ONLINE_NOT_AVAILABLE' });
  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`subscription:${id}`}))`; // one payment at a time
    const s = await loadCurrent(tx, id);
    if (s.priceAtStart === 0) throw new AppError(409, 'Nothing is due on a free plan', { code: 'NOTHING_DUE' });
    const now = new Date();
    const periodStart = s.currentPeriodEnd ?? s.startsAt;
    const periodEnd = addMonths(periodStart, MONTHS[s.period]);
    const inTrial = s.status === 'TRIAL' && s.trialEndsAt && s.trialEndsAt > now;
    const status = inTrial ? 'TRIAL' : periodEnd > now ? 'ACTIVE' : 'PAST_DUE';
    const payment = await tx.subscriptionPayment.create({
      data: { subscriptionId: id, amount, method, reference: reference ?? null, paidAt: paidAt ?? now, recordedById: admin.id, periodStart, periodEnd },
    });
    await tx.shopSubscription.update({ where: { id }, data: { currentPeriodEnd: periodEnd, status, expiryNoticeDays: null } });
    await audit(tx, admin.id, 'subscription.payment_recorded', 'ShopSubscription', id, { paymentId: payment.id, amount, method, periodStart, periodEnd });
    return payment;
  });
  return { payment: result, subscription: presentSub(await loadSub(id)) };
}

export async function refundPayment(admin, paymentId, { note }) {
  const subId = await prisma.$transaction(async (tx) => {
    const p = await tx.subscriptionPayment.findUnique({ where: { id: paymentId }, include: { subscription: true } });
    if (!p) throw new AppError(404, 'Payment not found');
    if (p.status === 'REFUNDED') throw new AppError(409, 'This payment was already refunded', { code: 'ALREADY_REFUNDED' });
    const now = new Date();
    await tx.subscriptionPayment.update({ where: { id: paymentId }, data: { status: 'REFUNDED', refundedAt: now, refundedById: admin.id, refundNote: note ?? null } });
    const s = p.subscription;
    // the latest paid period of a current subscription is taken back
    if (s.isCurrent && s.currentPeriodEnd && s.currentPeriodEnd.getTime() === p.periodEnd.getTime()) {
      const end = p.periodStart;
      const status = s.status === 'ACTIVE' && end <= now ? 'PAST_DUE' : s.status;
      await tx.shopSubscription.update({ where: { id: s.id }, data: { currentPeriodEnd: end, status } });
    }
    await audit(tx, admin.id, 'subscription.payment_refunded', 'SubscriptionPayment', paymentId, { subscriptionId: s.id, amount: p.amount });
    return s.id;
  });
  const payment = await prisma.subscriptionPayment.findUnique({ where: { id: paymentId } });
  return { payment, subscription: presentSub(await loadSub(subId)) };
}

// ---------- reports ----------

const dhakaToday = () => new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString().slice(0, 10);
const dhakaStart = (d) => new Date(`${d}T00:00:00+06:00`);
const dhakaDayOf = (date) => new Date(new Date(date).getTime() + 6 * 60 * 60 * 1000).toISOString().slice(0, 10);

function range({ from, to }) {
  const toDay = to ?? dhakaToday();
  const fromDay = from ?? dhakaDayOf(dhakaStart(toDay).getTime() - 29 * DAY_MS);
  if ((dhakaStart(toDay) - dhakaStart(fromDay)) / DAY_MS > 366) throw new AppError(400, 'The range can be at most one year');
  return { fromDay, toDay, start: dhakaStart(fromDay), end: new Date(dhakaStart(toDay).getTime() + DAY_MS) };
}

export async function summary(q) {
  const { fromDay, toDay, start, end } = range(q);
  const now = new Date();
  const [shopCount, current, plans, payments, ended] = await Promise.all([
    prisma.shop.count(),
    prisma.shopSubscription.findMany({ where: { isCurrent: true } }),
    prisma.subscriptionPlan.findMany({ select: { id: true, code: true, nameEn: true }, orderBy: planOrder }),
    prisma.subscriptionPayment.findMany({ where: { status: 'RECORDED', paidAt: { gte: start, lt: end } }, include: { subscription: { select: { planId: true } } } }),
    prisma.shopSubscription.findMany({ where: { isCurrent: false, endedAt: { gte: start, lt: end }, status: { in: ['CANCELLED', 'EXPIRED'] }, priceAtStart: { gt: 0 } }, select: { shopId: true } }),
  ]);
  const implicitFree = shopCount - current.length; // shops that never had a row use the FREE plan
  const free = plans.find((p) => p.code === 'FREE');

  const byStatus = Object.fromEntries(['TRIAL', 'ACTIVE', 'PAST_DUE', 'FREE'].map((s) => [s, 0]));
  for (const s of current) byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
  byStatus.FREE += implicitFree;

  const shopsOfPlan = new Map();
  for (const s of current) shopsOfPlan.set(s.planId, (shopsOfPlan.get(s.planId) ?? 0) + 1);
  if (free) shopsOfPlan.set(free.id, (shopsOfPlan.get(free.id) ?? 0) + implicitFree);

  const paying = current.filter((s) => PAYING.includes(s.status) && s.priceAtStart > 0);
  const mrr = paying.reduce((sum, s) => sum + s.priceAtStart / MONTHS[s.period], 0);

  const byDay = new Map();
  const revenueOfPlan = new Map();
  for (const p of payments) {
    const d = dhakaDayOf(p.paidAt);
    byDay.set(d, (byDay.get(d) ?? 0) + p.amount);
    revenueOfPlan.set(p.subscription.planId, (revenueOfPlan.get(p.subscription.planId) ?? 0) + p.amount);
  }
  const days = [];
  for (let t = start.getTime(); t < end.getTime(); t += DAY_MS) {
    const d = dhakaDayOf(t);
    days.push({ day: d, amount: byDay.get(d) ?? 0 });
  }

  // churned = a shop whose paid subscription ended in the range and that is not on a paid plan now
  const payingNow = new Set(current.filter((s) => s.priceAtStart > 0 && s.status !== 'FREE').map((s) => s.shopId));
  const churned = new Set(ended.map((e) => e.shopId).filter((id) => !payingNow.has(id))).size;

  return {
    from: fromDay,
    to: toDay,
    shops: shopCount,
    byStatus,
    byPlan: plans.map((p) => ({ planId: p.id, code: p.code, nameEn: p.nameEn, shops: shopsOfPlan.get(p.id) ?? 0 })),
    counts: {
      paying: paying.length,
      trial: byStatus.TRIAL,
      free: shopCount - paying.length - byStatus.TRIAL,
      unpaid: paying.filter((s) => s.currentPeriodEnd && s.currentPeriodEnd <= now).length,
      expiringNext7Days: current.filter((s) => ['TRIAL', 'ACTIVE'].includes(s.status) && s.currentPeriodEnd > now && s.currentPeriodEnd <= addDays(now, 7)).length,
      churned,
    },
    mrr: Math.round(mrr),
    revenue: {
      total: payments.reduce((sum, p) => sum + p.amount, 0),
      byDay: days,
      byPlan: plans.map((p) => ({ planId: p.id, code: p.code, amount: revenueOfPlan.get(p.id) ?? 0 })).filter((r) => r.amount > 0),
    },
  };
}

// usage per module from the real tables (who uses what before prices are chosen); rows { shopId, n }
const SINCE_DAYS = 30;
const USAGE = {
  ANALYTICS: null, // views of the owner analytics are not stored
  CSV_IMPORT: { metric: 'CSV imports in the last 30 days', sql: (since) => Prisma.sql`SELECT "entityId" AS "shopId", count(*)::int AS n FROM "AuditLog" WHERE action = 'listing.imported' AND "entityType" = 'Shop' AND "createdAt" >= ${since} GROUP BY 1` },
  PROMOTIONS: {
    metric: 'active flash deals + active coupons',
    sql: (since, now) => Prisma.sql`SELECT "shopId", sum(n)::int AS n FROM (
        SELECT l."shopId", count(*) AS n FROM "FlashDeal" d JOIN "ShopListing" l ON l.id = d."listingId" WHERE d."endsAt" > ${now} GROUP BY 1
        UNION ALL SELECT c."shopId", count(*) AS n FROM "Coupon" c WHERE c."isActive" AND c."endsAt" > ${now} GROUP BY 1) x GROUP BY 1`,
  },
  FEATURED_SLOTS: { metric: 'featured shop slots', sql: () => Prisma.sql`SELECT "targetId" AS "shopId", count(*)::int AS n FROM "FeaturedSlot" WHERE kind = 'SHOP' GROUP BY 1` },
  STAFF_ACCOUNTS: { metric: 'staff accounts', sql: () => Prisma.sql`SELECT "shopId", count(*)::int AS n FROM "ShopStaff" GROUP BY 1` },
  BARGAINING: { metric: 'listings with bargaining on', sql: () => Prisma.sql`SELECT "shopId", count(*)::int AS n FROM "ShopListing" WHERE "bargainEnabled" GROUP BY 1` },
  ORDER_CHAT: {
    metric: 'shop chat messages in the last 30 days',
    sql: (since) => Prisma.sql`SELECT o."shopId", count(*)::int AS n FROM "OrderMessage" m JOIN "SubOrder" o ON o.id = m."subOrderId" WHERE m."senderRole" = 'SHOP' AND m."createdAt" >= ${since} GROUP BY 1`,
  },
  COURIER_DELIVERY: { metric: 'courier shipments in the last 30 days', sql: (since) => Prisma.sql`SELECT "shopId", count(*)::int AS n FROM "Shipment" WHERE "createdAt" >= ${since} GROUP BY 1` },
  SHOP_PHOTOS_EXTRA: {
    metric: `shop photos (shops with more than ${FREE_SHOP_PHOTOS})`,
    sql: () => Prisma.sql`SELECT "shopId", count(*)::int AS n FROM "ShopPhoto" GROUP BY 1 HAVING count(*) > ${FREE_SHOP_PHOTOS}`,
  },
  PRIORITY_SUPPORT: null, // not tracked
};

export async function usage({ moduleCode }) {
  const now = new Date();
  const since = addDays(now, -SINCE_DAYS);
  const top = moduleCode ? 200 : 20;
  const codes = moduleCode ? [moduleCode] : MODULES;
  const measured = await Promise.all(
    codes.map(async (code) => {
      const u = USAGE[code];
      if (!u) return { module: code, metric: null, tracked: false, rows: [] };
      return { module: code, metric: u.metric, tracked: true, rows: await prisma.$queryRaw(u.sql(since, now)) };
    }),
  );
  const products = await prisma.$queryRaw`SELECT "shopId", count(*)::int AS n FROM "ShopListing" GROUP BY 1`;
  const ids = [...new Set([...measured.flatMap((m) => m.rows.map((r) => r.shopId)), ...products.map((r) => r.shopId)])];
  const shops = new Map((await prisma.shop.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, slug: true } })).map((s) => [s.id, s]));
  const shape = (rows) => {
    const known = rows.filter((r) => shops.has(r.shopId)).sort((a, b) => b.n - a.n);
    return {
      shopCount: known.length,
      total: known.reduce((sum, r) => sum + r.n, 0),
      top: known.slice(0, top).map((r) => ({ shopId: r.shopId, name: shops.get(r.shopId).name, slug: shops.get(r.shopId).slug, count: r.n })),
    };
  };
  return {
    since: since.toISOString(),
    modules: measured.map((m) => ({ module: m.module, metric: m.metric, tracked: m.tracked, ...shape(m.rows) })),
    products: { metric: 'listings per shop', ...shape(products) },
  };
}

// ---------- plan requests ----------

const requestInclude = {
  shop: { select: { id: true, name: true, slug: true, ownerId: true } },
  plan: { select: { id: true, code: true, nameEn: true, nameBn: true } },
};
const presentRequest = (r) => ({
  id: r.id,
  shop: r.shop ? { id: r.shop.id, name: r.shop.name, slug: r.shop.slug } : undefined,
  plan: r.plan,
  period: r.period,
  status: r.status,
  rejectNote: r.rejectNote,
  subscriptionId: r.subscriptionId,
  decidedAt: r.decidedAt,
  createdAt: r.createdAt,
});

export async function listRequests({ status, page, limit }) {
  const where = { status };
  const [total, rows] = await Promise.all([
    prisma.subscriptionRequest.count({ where }),
    prisma.subscriptionRequest.findMany({ where, include: requestInclude, orderBy: { createdAt: status === 'PENDING' ? 'asc' : 'desc' }, skip: (page - 1) * limit, take: limit }),
  ]);
  return { items: rows.map(presentRequest), pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

async function pendingRequest(tx, id) {
  const r = await tx.subscriptionRequest.findUnique({ where: { id }, include: requestInclude });
  if (!r) throw new AppError(404, 'Request not found');
  if (r.status !== 'PENDING') throw new AppError(409, 'This request was already decided', { code: 'NOT_PENDING' });
  return r;
}

export async function approveRequest(admin, id, { startsAt, trialDays, note }) {
  const r = await prisma.$transaction(async (tx) => {
    const req = await pendingRequest(tx, id);
    const subId = await startSubscription(admin, req.shop.id, { planId: req.plan.id, period: req.period, startsAt, trialDays, note }, { source: 'SELF_SERVE', tx });
    await tx.subscriptionRequest.update({ where: { id }, data: { status: 'APPROVED', decidedById: admin.id, decidedAt: new Date(), subscriptionId: subId } });
    await audit(tx, admin.id, 'subscription.request_approved', 'SubscriptionRequest', id, { subscriptionId: subId });
    return req;
  });
  await notify([r.shop.ownerId], {
    type: 'SUBSCRIPTION_REQUEST_APPROVED',
    title: `Your ${r.plan.nameEn} plan is on`,
    body: `${r.shop.name} is now on the ${r.plan.nameEn} plan.`,
    data: { shopId: r.shop.id, requestId: id },
  });
  return presentRequest(await prisma.subscriptionRequest.findUnique({ where: { id }, include: requestInclude }));
}

export async function rejectRequest(admin, id, { note }) {
  const r = await prisma.$transaction(async (tx) => {
    const req = await pendingRequest(tx, id);
    await tx.subscriptionRequest.update({ where: { id }, data: { status: 'REJECTED', decidedById: admin.id, decidedAt: new Date(), rejectNote: note } });
    await audit(tx, admin.id, 'subscription.request_rejected', 'SubscriptionRequest', id, { note });
    return req;
  });
  await notify([r.shop.ownerId], {
    type: 'SUBSCRIPTION_REQUEST_REJECTED',
    title: 'Your plan request was not approved',
    body: note,
    data: { shopId: r.shop.id, requestId: id },
  });
  return presentRequest(await prisma.subscriptionRequest.findUnique({ where: { id }, include: requestInclude }));
}

// ---------- shop side (owner / staff) ----------

const OFF = { enabled: false };

export async function shopEntitlements(user, shopId) {
  await assertShopAccess(user, shopId);
  const e = await entitlementsOf(shopId);
  return { enabled: e.enabled, modules: e.modules, limits: e.limits };
}

export async function shopSubscription(user, shopId) {
  await assertShopAccess(user, shopId);
  const e = await entitlementsOf(shopId);
  if (!e.enabled) return OFF;
  const [used, plans, pending] = await Promise.all([
    usageOf(shopId),
    prisma.subscriptionPlan.findMany({ where: { isPublished: true, isActive: true }, include: { prices: true }, orderBy: planOrder }),
    prisma.subscriptionRequest.findFirst({ where: { shopId, status: 'PENDING' }, include: requestInclude }),
  ]);
  const s = e.subscription && e.subscription.isCurrent ? e.subscription : null;
  const paid = s ? paidThisPeriod(s) : true;
  return {
    enabled: true,
    subscription: s
      ? {
          period: s.period,
          status: s.status,
          startsAt: s.startsAt,
          currentPeriodEnd: s.currentPeriodEnd,
          trialEndsAt: s.trialEndsAt,
          cancelAtPeriodEnd: s.cancelAtPeriodEnd,
          price: s.priceAtStart,
          amountDue: paid ? 0 : s.priceAtStart,
        }
      : null,
    plan: e.plan ? presentPlan(e.plan, { activeOnly: true }) : null,
    modules: e.modules,
    limits: Object.fromEntries(LIMITS.map((l) => [l, { limit: e.limits[l], used: used[l] }])),
    plans: plans.map((p) => presentPlan(p, { activeOnly: true })).filter((p) => p.prices.length > 0),
    pendingRequest: pending ? presentRequest(pending) : null,
  };
}

export async function requestPlan(user, shopId, { planId, period }) {
  const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { id: true, name: true, ownerId: true } });
  if (!shop) throw new AppError(404, 'Shop not found');
  if (shop.ownerId !== user.id) throw new AppError(403, 'Only the shop owner can do this');
  if (!(await getSettings()).subscriptionsEnabled) return OFF;
  const plan = await prisma.subscriptionPlan.findUnique({ where: { id: planId }, include: { prices: true } });
  const price = plan?.prices.find((p) => p.period === period && p.isActive);
  if (!plan || !plan.isPublished || !plan.isActive || !price) {
    throw new AppError(400, 'This plan is not available for that period', { code: 'PLAN_NOT_AVAILABLE' });
  }
  let r;
  try {
    r = await prisma.$transaction(async (tx) => {
      const made = await tx.subscriptionRequest.create({ data: { shopId, planId, period, requestedById: user.id }, include: requestInclude });
      await audit(tx, user.id, 'subscription.requested', 'SubscriptionRequest', made.id, { shopId, plan: plan.code, period });
      return made;
    });
  } catch (err) {
    if (err.code === 'P2002') throw new AppError(409, 'You already asked for a plan. Wait for our answer', { code: 'REQUEST_PENDING' });
    throw err;
  }
  const admins = await prisma.user.findMany({ where: { role: 'ADMIN', isActive: true }, select: { id: true } });
  await notify(admins.map((a) => a.id), {
    type: 'SUBSCRIPTION_REQUEST',
    title: 'A shop asked for a plan',
    body: `${shop.name}: ${plan.nameEn} (${period.toLowerCase().replace('_', ' ')})`,
    data: { shopId, requestId: r.id },
  });
  return { enabled: true, request: presentRequest(r) };
}

export { currentSubscription };
