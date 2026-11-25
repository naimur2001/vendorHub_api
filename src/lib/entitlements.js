// What a shop's plan unlocks. While subscriptionsEnabled is false every module is on and there are no
// limits (no-op guards), so publishing subscriptions later is only the switch.
//   requireModule(code, when?) -> 402 { code: 'PLAN_REQUIRED', module }
//   checkLimit(name)           -> 409 { code: 'PLAN_LIMIT', name, limit, used }
// Guards run after authenticate; they only judge the shop's own team (admins and outsiders pass on to
// the route, which answers 403/404 as before).
import { prisma } from './prisma.js';
import { AppError } from './errors.js';
import { getSetting } from './settings.js';

export const MODULES = [
  'ANALYTICS',
  'CSV_IMPORT',
  'PROMOTIONS',
  'FEATURED_SLOTS',
  'STAFF_ACCOUNTS',
  'BARGAINING',
  'ORDER_CHAT',
  'COURIER_DELIVERY',
  'SHOP_PHOTOS_EXTRA',
  'PRIORITY_SUPPORT',
];
export const LIMITS = ['maxProducts', 'maxStaff', 'maxActiveDeals'];
export const FREE_SHOP_PHOTOS = 3; // more photos than this need SHOP_PHOTOS_EXTRA
const LIVE = ['TRIAL', 'ACTIVE', 'PAST_DUE', 'FREE']; // a current row in these states gives its plan
const noLimits = () => Object.fromEntries(LIMITS.map((l) => [l, null]));

export const currentSubscription = (shopId, db = prisma) =>
  db.shopSubscription.findFirst({ where: { shopId, isCurrent: true }, include: { plan: { include: { prices: true } } } });

export const freePlan = (db = prisma) => db.subscriptionPlan.findUnique({ where: { code: 'FREE' }, include: { prices: true } });

/** { enabled, modules, limits, plan, subscription } of a shop. */
export async function entitlementsOf(shopId, db = prisma) {
  if (!(await getSetting('subscriptionsEnabled'))) {
    return { enabled: false, modules: [...MODULES], limits: noLimits(), plan: null, subscription: null };
  }
  const sub = await currentSubscription(shopId, db);
  const plan = sub && LIVE.includes(sub.status) ? sub.plan : await freePlan(db);
  return {
    enabled: true,
    modules: plan ? MODULES.filter((m) => plan.modules.includes(m)) : [],
    limits: plan ? Object.fromEntries(LIMITS.map((l) => [l, plan[l]])) : noLimits(),
    plan,
    subscription: sub,
  };
}

/** What the shop uses now, for the limits. */
export async function usageOf(shopId, db = prisma) {
  const now = new Date();
  const [products, staff, activeDeals] = await Promise.all([
    db.shopListing.count({ where: { shopId } }),
    db.shopStaff.count({ where: { shopId } }),
    db.flashDeal.count({ where: { listing: { shopId }, endsAt: { gt: now } } }),
  ]);
  return { maxProducts: products, maxStaff: staff, maxActiveDeals: activeDeals };
}

// only the shop's own team is judged by the plan
async function isShopTeam(user, shopId) {
  if (!user || user.role === 'ADMIN' || typeof shopId !== 'string') return false;
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { ownerId: true, staff: { where: { userId: user.id }, select: { userId: true } } },
  }).catch(() => null);
  return Boolean(shop && (shop.ownerId === user.id || shop.staff.length));
}

/** Middleware: the shop's plan must include the module (only when `when(req)` is true, if given). */
export const requireModule = (code, when) => async (req, res, next) => {
  if (!(await getSetting('subscriptionsEnabled'))) return next();
  const shopId = req.params.shopId;
  if (!(await isShopTeam(req.user, shopId))) return next();
  if (when && !(await when(req, shopId))) return next();
  const e = await entitlementsOf(shopId);
  if (!e.modules.includes(code)) throw new AppError(402, 'Your plan does not include this feature', { code: 'PLAN_REQUIRED', module: code });
  next();
};

/** Middleware: one more of `name` (maxProducts, maxStaff, maxActiveDeals) must fit the plan's limit. */
export const checkLimit = (name) => async (req, res, next) => {
  if (!(await getSetting('subscriptionsEnabled'))) return next();
  const shopId = req.params.shopId;
  if (!(await isShopTeam(req.user, shopId))) return next();
  const e = await entitlementsOf(shopId);
  const limit = e.limits[name];
  if (limit === null || limit === undefined) return next();
  const used = (await usageOf(shopId))[name];
  if (used >= limit) throw new AppError(409, 'Your plan limit is reached', { code: 'PLAN_LIMIT', name, limit, used });
  next();
};
