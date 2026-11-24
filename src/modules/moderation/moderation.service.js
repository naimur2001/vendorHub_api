// Admin curation and moderation: featured slots, product moderation, and content flags.
// Every admin decision writes an audit log entry. Reporter identities are never shown.
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { notify } from '../../lib/notify.js';
import { thumbFor, imageUrls } from '../../lib/storage.js';
import { activeDeals, effectivePrice } from '../../lib/deals.js';
import { shopTeamIds } from '../notifications/notifications.events.js';

export const MAX_FEATURED_PER_KIND = 12;
export const MAX_FLAGS_PER_DAY = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

const audit = (db, admin, action, entityType, entityId, meta) =>
  db.auditLog.create({ data: { actorId: admin.id, action, entityType, entityId, meta } });

// ---------- featured slots ----------
const live = (s, now = new Date()) => (!s.startsAt || s.startsAt <= now) && (!s.endsAt || s.endsAt > now);

async function assertTarget(kind, targetId) {
  const ok =
    kind === 'SHOP'
      ? await prisma.shop.count({ where: { id: targetId, isActive: true } })
      : await prisma.product.count({ where: { id: targetId, isActive: true, moderationStatus: 'APPROVED' } });
  if (!ok) throw new AppError(404, kind === 'SHOP' ? 'Shop not found' : 'Product not found');
}

// What each slot points at, for the admin list: one query per kind, inactive targets included
// (so an admin can see and remove them). A deleted shop or product -> no entry -> target null.
async function loadTargets(slots) {
  const ids = (kind) => [...new Set(slots.filter((s) => s.kind === kind).map((s) => s.targetId))];
  const shopIds = ids('SHOP');
  const productIds = ids('PRODUCT');
  const [shops, products] = await Promise.all([
    shopIds.length
      ? prisma.shop.findMany({ where: { id: { in: shopIds } }, select: { id: true, name: true, slug: true, isActive: true } })
      : [],
    productIds.length
      ? prisma.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, title: true, slug: true, isActive: true, moderationStatus: true },
        })
      : [],
  ]);
  const map = new Map();
  for (const x of shops) map.set(`SHOP:${x.id}`, { name: x.name, slug: x.slug, isActive: x.isActive });
  for (const x of products) {
    map.set(`PRODUCT:${x.id}`, { name: x.title, slug: x.slug, isActive: x.isActive, moderationStatus: x.moderationStatus });
  }
  return map;
}

const presentSlot = (s, targets) => ({
  id: s.id,
  kind: s.kind,
  targetId: s.targetId,
  sortOrder: s.sortOrder,
  startsAt: s.startsAt,
  endsAt: s.endsAt,
  liveNow: live(s),
  createdAt: s.createdAt,
  target: targets.get(`${s.kind}:${s.targetId}`) ?? null,
});

const presentSlots = async (slots) => {
  const targets = await loadTargets(slots);
  return slots.map((s) => presentSlot(s, targets));
};
const presentOne = async (slot) => (await presentSlots([slot]))[0];

export async function listFeaturedAdmin({ kind }) {
  const rows = await prisma.featuredSlot.findMany({
    where: kind ? { kind } : {},
    orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
  return presentSlots(rows);
}

export async function createFeatured(admin, { kind, targetId, startsAt, endsAt }) {
  if (startsAt && endsAt && endsAt <= startsAt) throw new AppError(400, 'endsAt must be after startsAt');
  await assertTarget(kind, targetId);
  try {
    const slot = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`featured:${kind}`}))`;
      const count = await tx.featuredSlot.count({ where: { kind } });
      if (count >= MAX_FEATURED_PER_KIND) {
        throw new AppError(409, `At most ${MAX_FEATURED_PER_KIND} featured items of this kind. Remove one first.`, { code: 'FEATURED_LIMIT' });
      }
      const last = await tx.featuredSlot.aggregate({ where: { kind }, _max: { sortOrder: true } });
      const s = await tx.featuredSlot.create({
        data: { kind, targetId, startsAt: startsAt ?? null, endsAt: endsAt ?? null, sortOrder: (last._max.sortOrder ?? -1) + 1 },
      });
      await audit(tx, admin, 'featured.created', 'FeaturedSlot', s.id, { kind, targetId });
      return s;
    });
    return presentOne(slot);
  } catch (err) {
    if (err.code === 'P2002') throw new AppError(409, 'This item is already featured', { code: 'FEATURED_DUPLICATE' });
    throw err;
  }
}

export async function updateFeatured(admin, id, input) {
  const slot = await prisma.featuredSlot.findUnique({ where: { id } });
  if (!slot) throw new AppError(404, 'Featured item not found');
  const startsAt = input.startsAt !== undefined ? input.startsAt : slot.startsAt;
  const endsAt = input.endsAt !== undefined ? input.endsAt : slot.endsAt;
  if (startsAt && endsAt && endsAt <= startsAt) throw new AppError(400, 'endsAt must be after startsAt');
  const updated = await prisma.$transaction(async (tx) => {
    const s = await tx.featuredSlot.update({ where: { id }, data: input });
    await audit(tx, admin, 'featured.updated', 'FeaturedSlot', id, { fields: Object.keys(input) });
    return s;
  });
  return presentOne(updated);
}

export async function deleteFeatured(admin, id) {
  const slot = await prisma.featuredSlot.findUnique({ where: { id } });
  if (!slot) throw new AppError(404, 'Featured item not found');
  await prisma.$transaction([
    prisma.featuredSlot.delete({ where: { id } }),
    audit(prisma, admin, 'featured.deleted', 'FeaturedSlot', id, { kind: slot.kind, targetId: slot.targetId }),
  ]);
}

// Like banners: ids of ONE kind, sortOrder 0, 1, 2 ... in this order.
export async function reorderFeatured(admin, ids) {
  const rows = await prisma.featuredSlot.findMany({ where: { id: { in: ids } }, select: { kind: true } });
  if (rows.length !== ids.length) throw new AppError(404, 'Featured item not found');
  const kinds = new Set(rows.map((r) => r.kind));
  if (kinds.size > 1) throw new AppError(400, 'Reorder the featured items of one kind at a time');
  const [kind] = kinds;
  await prisma.$transaction(async (tx) => {
    for (const [i, id] of ids.entries()) await tx.featuredSlot.update({ where: { id }, data: { sortOrder: i } });
    await audit(tx, admin, 'featured.reordered', 'FeaturedSlot', ids[0], { kind, ids });
  });
  return listFeaturedAdmin({ kind });
}

// Public: the live slots of one kind, in order, with the card data; hidden targets are left out.
export async function publicFeatured({ kind }) {
  const now = new Date();
  const slots = (await prisma.featuredSlot.findMany({ where: { kind }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] })).filter((s) =>
    live(s, now),
  );
  const ids = slots.map((s) => s.targetId);
  if (kind === 'SHOP') {
    const shops = await prisma.shop.findMany({
      where: { id: { in: ids }, isActive: true },
      select: { id: true, name: true, slug: true, logoUrl: true, verificationLevel: true, market: { select: { name: true, slug: true } } },
    });
    const byId = new Map(shops.map((s) => [s.id, s]));
    return slots.filter((s) => byId.has(s.targetId)).map((s) => ({ slotId: s.id, shop: byId.get(s.targetId) }));
  }
  const products = await prisma.product.findMany({
    where: { id: { in: ids }, isActive: true, moderationStatus: 'APPROVED' },
    select: {
      id: true,
      slug: true,
      title: true,
      images: true,
      msrp: true,
      listings: { where: { isActive: true, shop: { isActive: true } }, select: { id: true, price: true } },
    },
  });
  const deals = await activeDeals(products.flatMap((p) => p.listings.map((l) => l.id)), prisma, now);
  const byId = new Map(products.filter((p) => p.listings.length).map((p) => [p.id, p]));
  return slots
    .filter((s) => byId.has(s.targetId))
    .map((s) => {
      const p = byId.get(s.targetId);
      const image = p.images[0] ?? null;
      return {
        slotId: s.id,
        product: {
          id: p.id,
          slug: p.slug,
          title: p.title,
          image,
          thumbnail: thumbFor(image),
          msrp: p.msrp,
          lowestPrice: Math.min(...p.listings.map((l) => effectivePrice(l.price, deals.get(l.id)))),
          shopCount: p.listings.length,
        },
      };
    });
}

// ---------- product moderation ----------
const presentPending = (p) => ({
  id: p.id,
  slug: p.slug,
  title: p.title,
  description: p.description,
  msrp: p.msrp,
  images: p.images,
  category: p.category,
  brand: p.brand,
  source: p.source,
  shop: p.createdByShop ?? null,
  moderationStatus: p.moderationStatus,
  moderationNote: p.moderationNote,
  moderatedAt: p.moderatedAt,
  createdAt: p.createdAt,
});

export async function listModeration({ status, page, limit }) {
  const where = { moderationStatus: status };
  const [total, rows] = await Promise.all([
    prisma.product.count({ where }),
    prisma.product.findMany({
      where,
      // waiting items oldest first; approved ones newest first so the admin can look over fresh products
      orderBy: status === 'APPROVED' ? [{ createdAt: 'desc' }, { id: 'desc' }] : [{ createdAt: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * limit,
      take: limit,
      include: {
        category: { select: { id: true, name: true, slug: true } },
        brand: { select: { id: true, name: true } },
        createdByShop: { select: { id: true, name: true, slug: true } },
      },
    }),
  ]);
  return { items: rows.map(presentPending), pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

async function decide(admin, productId, status, reason) {
  const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true, title: true, createdByShopId: true, moderationStatus: true } });
  if (!product) throw new AppError(404, 'Product not found');
  if (product.moderationStatus === status) throw new AppError(409, `The product is already ${status}`);
  await prisma.$transaction([
    prisma.product.update({
      where: { id: productId },
      data: { moderationStatus: status, moderationNote: status === 'REJECTED' ? reason : null, moderatedAt: new Date() },
    }),
    audit(prisma, admin, status === 'APPROVED' ? 'moderation.product_approved' : 'moderation.product_rejected', 'Product', productId, {
      ...(reason && { reason }),
    }),
  ]);
  if (product.createdByShopId) {
    await notify(await shopTeamIds(product.createdByShopId), {
      type: 'PRODUCT_MODERATION',
      title: status === 'APPROVED' ? `Approved: ${product.title}` : `Not approved: ${product.title}`,
      body: status === 'APPROVED' ? 'Your product is now visible to customers.' : `Reason: ${reason}. Edit the product to send it again.`,
      data: { productId, status, shopId: product.createdByShopId },
    });
  }
  return { id: productId, moderationStatus: status, moderationNote: status === 'REJECTED' ? reason : null };
}
export const approveProduct = (admin, id) => decide(admin, id, 'APPROVED', null);
export const rejectProduct = (admin, id, reason) => decide(admin, id, 'REJECTED', reason);

// ---------- flags ----------
// Automatic flags on reviews: links, phone numbers, or repeated text.
const LINK = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|info|xyz|io|me|link|bd|shop|site)\b)/i;
const PHONE = /(?:\+?880|0)1[3-9]\d{8}/; // Bangladesh mobile, after removing spaces and dashes
const REPEATED = /(.)\1{7,}/; // the same character 8 times or more

export async function autoFlagReview(review) {
  try {
    const text = review.comment ?? '';
    if (!text) return;
    let reason = null;
    if (PHONE.test(text.replace(/[\s\-().]/g, ''))) reason = 'PERSONAL_INFO';
    else if (LINK.test(text) || REPEATED.test(text)) reason = 'SPAM';
    else if (text.trim().length >= 10) {
      // the same text in another review by the same person
      const same = await prisma.review.count({
        where: { userId: review.userId, id: { not: review.id }, comment: { equals: text.trim(), mode: 'insensitive' } },
      });
      if (same) reason = 'SPAM';
    }
    if (!reason) return;
    const open = await prisma.contentFlag.count({ where: { targetType: 'REVIEW', targetId: review.id, auto: true, status: 'OPEN' } });
    if (open) return;
    await prisma.contentFlag.create({ data: { targetType: 'REVIEW', targetId: review.id, reason, auto: true, note: 'Flagged automatically' } });
  } catch {
    // never breaks writing a review
  }
}

// May this user see (and so report) the target? Returns the target or throws 404.
async function reportableTarget(user, targetType, targetId) {
  if (targetType === 'REVIEW') {
    const r = await prisma.review.findFirst({ where: { id: targetId, isHidden: false }, select: { id: true, userId: true } });
    if (!r) throw new AppError(404, 'Review not found');
    if (r.userId === user.id) throw new AppError(400, 'You cannot report your own review');
    return r;
  }
  if (targetType === 'REVIEW_PHOTO') {
    const p = await prisma.reviewPhoto.findFirst({
      where: { id: targetId, isHidden: false, review: { isHidden: false } },
      select: { id: true, review: { select: { userId: true } } },
    });
    if (!p) throw new AppError(404, 'Photo not found');
    if (p.review.userId === user.id) throw new AppError(400, 'You cannot report your own photo');
    return p;
  }
  const m = await prisma.orderMessage.findFirst({
    where: { id: targetId, isHidden: false },
    select: { id: true, senderUserId: true, subOrder: { select: { shopId: true, checkout: { select: { userId: true } } } } },
  });
  if (!m) throw new AppError(404, 'Message not found');
  const team = await shopTeamIds(m.subOrder.shopId);
  const participant = m.subOrder.checkout.userId === user.id || team.includes(user.id);
  if (!participant) throw new AppError(404, 'Message not found'); // someone else's chat: not found
  if (m.senderUserId === user.id) throw new AppError(400, 'You cannot report your own message');
  return m;
}

export async function report(user, { targetType, targetId, reason, note }) {
  await reportableTarget(user, targetType, targetId);
  const existing = await prisma.contentFlag.findUnique({ where: { targetType_targetId_reporterId: { targetType, targetId, reporterId: user.id } } });
  if (existing) return { created: false, flag: { id: existing.id, status: existing.status } };
  const today = await prisma.contentFlag.count({ where: { reporterId: user.id, createdAt: { gt: new Date(Date.now() - DAY_MS) } } });
  if (today >= MAX_FLAGS_PER_DAY) throw new AppError(429, `At most ${MAX_FLAGS_PER_DAY} reports per day`, { code: 'FLAG_LIMIT' });
  try {
    const flag = await prisma.contentFlag.create({ data: { targetType, targetId, reporterId: user.id, reason, note: note ?? null } });
    return { created: true, flag: { id: flag.id, status: flag.status } };
  } catch (err) {
    if (err.code !== 'P2002') throw err; // the same report a moment ago
    const again = await prisma.contentFlag.findUnique({ where: { targetType_targetId_reporterId: { targetType, targetId, reporterId: user.id } } });
    return { created: false, flag: { id: again.id, status: again.status } };
  }
}

async function targets(flags) {
  const reviewIds = flags.filter((f) => f.targetType === 'REVIEW').map((f) => f.targetId);
  const messageIds = flags.filter((f) => f.targetType === 'ORDER_MESSAGE').map((f) => f.targetId);
  const photoIds = flags.filter((f) => f.targetType === 'REVIEW_PHOTO').map((f) => f.targetId);
  const photos = photoIds.length
    ? (await prisma.reviewPhoto.findMany({ where: { id: { in: photoIds } }, include: { image: { select: { key: true } } } })).map((p) => ({
        id: p.id,
        reviewId: p.reviewId,
        isHidden: p.isHidden,
        ...imageUrls(p.image.key),
      }))
    : [];
  const [reviews, messages] = await Promise.all([
    reviewIds.length
      ? prisma.review.findMany({ where: { id: { in: reviewIds } }, select: { id: true, type: true, rating: true, comment: true, isHidden: true, shopId: true, productId: true } })
      : [],
    messageIds.length
      ? prisma.orderMessage.findMany({ where: { id: { in: messageIds } }, select: { id: true, senderRole: true, body: true, isHidden: true, subOrderId: true } })
      : [],
  ]);
  return new Map([...reviews, ...messages, ...photos].map((t) => [t.id, t]));
}

export async function listFlags({ status, targetType, page, limit }) {
  const where = { status, ...(targetType && { targetType }) };
  const [total, rows] = await Promise.all([
    prisma.contentFlag.count({ where }),
    prisma.contentFlag.findMany({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], skip: (page - 1) * limit, take: limit }),
  ]);
  const t = await targets(rows);
  const reportCounts = await prisma.contentFlag.groupBy({
    by: ['targetId'],
    where: { targetId: { in: rows.map((r) => r.targetId) }, status },
    _count: { _all: true },
  });
  const countOf = new Map(reportCounts.map((c) => [c.targetId, c._count._all]));
  return {
    items: rows.map((f) => ({
      id: f.id,
      targetType: f.targetType,
      targetId: f.targetId,
      reason: f.reason,
      note: f.note,
      auto: f.auto,
      status: f.status,
      reportsOnTarget: countOf.get(f.targetId) ?? 1,
      target: t.get(f.targetId) ?? null, // null: the target was deleted meanwhile
      createdAt: f.createdAt,
      resolvedAt: f.resolvedAt,
      resolutionNote: f.resolutionNote,
    })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

// Resolves EVERY open flag of the same target: HIDE hides the review or message, KEEP leaves it.
export async function resolveFlag(admin, id, { action, note }) {
  const flag = await prisma.contentFlag.findUnique({ where: { id } });
  if (!flag) throw new AppError(404, 'Flag not found');
  if (flag.status !== 'OPEN') throw new AppError(409, 'This flag is already resolved');
  const status = action === 'HIDE' ? 'HIDDEN' : 'KEPT';
  const resolved = await prisma.$transaction(async (tx) => {
    if (action === 'HIDE') {
      const model = { REVIEW: tx.review, ORDER_MESSAGE: tx.orderMessage, REVIEW_PHOTO: tx.reviewPhoto }[flag.targetType];
      await model.updateMany({ where: { id: flag.targetId }, data: { isHidden: true } });
    }
    const { count } = await tx.contentFlag.updateMany({
      where: { targetType: flag.targetType, targetId: flag.targetId, status: 'OPEN' },
      data: { status, resolvedById: admin.id, resolvedAt: new Date(), resolutionNote: note ?? null },
    });
    const entity = { REVIEW: 'Review', ORDER_MESSAGE: 'OrderMessage', REVIEW_PHOTO: 'ReviewPhoto' }[flag.targetType];
    await audit(tx, admin, 'flag.resolved', entity, flag.targetId, { action, flags: count });
    return count;
  });
  return { status, resolvedFlags: resolved };
}
