// Product deletion: a shop owner asks to delete a product from their shop; this shop's listing (and,
// for PRODUCT scope, the product) is hidden at once and the request is carried out
// PRODUCT_DELETION_HOURS later (the job), unless an admin rejects or approves it first.
// Admins can also delete any product at once (DELETE /admin/products/:id/permanent).
//
// Scope, decided when the request is made and checked again when it is carried out:
//   PRODUCT  the shop created the product, it is not locked, and no other shop has an active listing
//            of it: the whole product goes
//   LISTING  every other case: only this shop's listing goes. If afterwards no active listing of the
//            product is left and the shop created it (not locked), the product goes too.
//
// Rules everywhere:
//   - anything with order items is never hard deleted: it is deactivated (outcome DEACTIVATED), so
//     order history stays intact
//   - a hard delete is one transaction (listings and what links to them, reviews, Image rows,
//     featured slots, the product); the image files are removed after the commit; audit log entry
//   - every PENDING request is claimed with a guarded update, so a request is carried out once
//     even if the job, an approve and an admin delete race each other
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { notify } from '../../lib/notify.js';
import { logger } from '../../lib/logger.js';
import { removeImage } from '../../lib/storage.js';
import { PRODUCT_DELETION_HOURS } from '../../config/limits.js';

const HOUR_MS = 60 * 60 * 1000;

const present = (r) => ({
  id: r.id,
  productId: r.productId,
  productTitle: r.productTitle,
  shopId: r.shopId,
  scope: r.scope,
  reason: r.reason,
  status: r.status,
  outcome: r.outcome,
  autoDeleteAt: r.autoDeleteAt,
  rejectNote: r.rejectNote,
  decidedAt: r.decidedAt,
  createdAt: r.createdAt,
});

const pageOf = (items, total, page, limit) => ({
  items,
  pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
});

async function adminIds() {
  const admins = await prisma.user.findMany({ where: { role: 'ADMIN', isActive: true }, select: { id: true } });
  return admins.map((a) => a.id);
}

async function notifyOwner(shopId, payload) {
  const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { ownerId: true } });
  if (shop) await notify([shop.ownerId], payload);
}

// Only the shop's owner (not staff, not admins: admins have their own endpoints).
async function ownerShop(user, shopId) {
  const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { id: true, ownerId: true, name: true } });
  if (!shop) throw new AppError(404, 'Shop not found');
  if (shop.ownerId !== user.id) throw new AppError(403, 'Only the shop owner can do this');
  return shop;
}

const restoreProduct = (tx, request) =>
  request.productWasActive
    ? tx.product.updateMany({ where: { id: request.productId, isActive: false }, data: { isActive: true } })
    : null;

// Puts back what the request hid, the way it was (this shop's listing; for PRODUCT scope the product).
async function restoreHidden(tx, request) {
  if (request.listingWasActive) {
    await tx.shopListing.updateMany({
      where: { shopId: request.shopId, productId: request.productId, isActive: false },
      data: { isActive: true },
    });
  }
  if (request.scope === 'PRODUCT') await restoreProduct(tx, request);
}

// The shop made the product and Vendors Hub has not locked it.
const ownsProduct = (product, shopId) => product.createdByShopId === shopId && !product.lockedAt;
const otherActiveListings = (db, productId, shopId) =>
  db.shopListing.count({ where: { productId, shopId: { not: shopId }, isActive: true } });

// ---------- the delete / deactivate core ----------

// Hard deletes listings and what hangs off them (cart items, wishlist items, bargains, flash deals;
// views and add-to-cart events cascade). The caller has checked that they have no order items.
async function clearListings(tx, listingIds) {
  if (!listingIds.length) return;
  const bargainIds = (await tx.bargain.findMany({ where: { listingId: { in: listingIds } }, select: { id: true } })).map((b) => b.id);
  await tx.cartItem.deleteMany({ where: { OR: [{ listingId: { in: listingIds } }, { bargainId: { in: bargainIds } }] } });
  await tx.wishlistItem.deleteMany({ where: { listingId: { in: listingIds } } });
  await tx.bargain.deleteMany({ where: { id: { in: bargainIds } } }); // bargain events cascade
  await tx.flashDeal.deleteMany({ where: { listingId: { in: listingIds } } });
  await tx.shopListing.deleteMany({ where: { id: { in: listingIds } } });
}

/**
 * Inside a transaction: deactivates the product if it has orders (or `forceDeactivate`), else
 * deletes it with everything that links to it. Returns null when the product does not exist.
 */
async function purgeInTx(tx, productId, forceDeactivate) {
  const product = await tx.product.findUnique({ where: { id: productId }, select: { id: true, title: true } });
  if (!product) return null;
  const listingIds = (await tx.shopListing.findMany({ where: { productId }, select: { id: true } })).map((l) => l.id);
  const ordered = listingIds.length ? await tx.orderItem.count({ where: { listingId: { in: listingIds } } }) : 0;

  if (ordered > 0 || forceDeactivate) {
    await tx.product.update({ where: { id: productId }, data: { isActive: false } });
    await tx.shopListing.updateMany({ where: { productId }, data: { isActive: false } });
    return { outcome: 'DEACTIVATED', title: product.title, keys: [], productGone: false };
  }

  await clearListings(tx, listingIds);

  const reviews = await tx.review.findMany({
    where: { productId },
    select: { id: true, photos: { select: { id: true, image: { select: { id: true, key: true } } } } },
  });
  const reviewIds = reviews.map((r) => r.id);
  const reviewPhotos = reviews.flatMap((r) => r.photos);
  if (reviewIds.length) {
    await tx.contentFlag.deleteMany({
      where: {
        OR: [
          { targetType: 'REVIEW', targetId: { in: reviewIds } },
          { targetType: 'REVIEW_PHOTO', targetId: { in: reviewPhotos.map((p) => p.id) } },
        ],
      },
    });
    await tx.review.deleteMany({ where: { id: { in: reviewIds } } }); // review photo rows cascade
    await tx.image.deleteMany({ where: { id: { in: reviewPhotos.map((p) => p.image.id) } } });
  }

  const photos = await tx.image.findMany({ where: { productId }, select: { key: true } });
  await tx.image.deleteMany({ where: { productId } });
  await tx.featuredSlot.deleteMany({ where: { kind: 'PRODUCT', targetId: productId } });
  await tx.product.delete({ where: { id: productId } });
  return {
    outcome: 'DELETED',
    title: product.title,
    keys: [...photos, ...reviewPhotos.map((p) => p.image)].map((i) => i.key),
    productGone: true,
  };
}

/** Carries out one claimed request inside its transaction. Returns { outcome, scope, keys, productGone }. */
async function carryOutInTx(tx, request, forceDeactivate) {
  const { productId, shopId } = request;
  const product = await tx.product.findUnique({ where: { id: productId }, select: { createdByShopId: true, lockedAt: true } });
  if (!product) return { outcome: 'DELETED', scope: request.scope, keys: [], productGone: true }; // already gone

  const others = await otherActiveListings(tx, productId, shopId);
  if (request.scope === 'PRODUCT' && ownsProduct(product, shopId) && others === 0) {
    return { ...(await purgeInTx(tx, productId, forceDeactivate)), scope: 'PRODUCT' };
  }

  // LISTING: chosen at create, or PRODUCT falling back because another shop listed it meanwhile (or it
  // was locked). The product stays for the others, so it is shown again.
  if (request.scope === 'PRODUCT') await restoreProduct(tx, request);
  const listing = await tx.shopListing.findUnique({ where: { shopId_productId: { shopId, productId } }, select: { id: true } });
  let outcome = 'LISTING_DELETED';
  if (listing) {
    const ordered = await tx.orderItem.count({ where: { listingId: listing.id } });
    if (ordered > 0 || forceDeactivate) {
      await tx.shopListing.update({ where: { id: listing.id }, data: { isActive: false } });
      outcome = 'DEACTIVATED';
    } else {
      await clearListings(tx, [listing.id]);
    }
  }
  // the last shop leaving a shop-made product takes it with it: no listing row is left at all (a listing
  // hidden by another shop's own pending request still counts, as that request may yet be rejected)
  if (outcome === 'LISTING_DELETED' && product.createdByShopId && !product.lockedAt && (await tx.shopListing.count({ where: { productId } })) === 0) {
    return { ...(await purgeInTx(tx, productId, forceDeactivate)), scope: 'LISTING' };
  }
  return { outcome, scope: 'LISTING', keys: [], productGone: false };
}

// Runs `work` in a transaction; if an order was placed between the check and the delete (order items
// keep the listing, so the delete fails with P2003), runs it again with "deactivate only".
async function withOrderFallback(work) {
  try {
    return await prisma.$transaction((tx) => work(tx, false));
  } catch (err) {
    if (err.code !== 'P2003') throw err;
    return prisma.$transaction((tx) => work(tx, true));
  }
}

const DONE_TEXT = {
  DELETED: (t) => `"${t}" has been deleted.`,
  LISTING_DELETED: (t) => `Your listing of "${t}" has been deleted. The product stays for other shops.`,
  DEACTIVATED: (t) => `"${t}" has orders, so it was deactivated instead of deleted. Order history stays.`,
};

// After the commit: image files, then one notification per closed request.
async function finish(result) {
  await Promise.all(result.keys.map((k) => removeImage(k).catch(() => {})));
  for (const r of result.requests) {
    await notifyOwner(r.shopId, {
      type: 'PRODUCT_DELETION_DONE',
      title: r.outcome === 'DEACTIVATED' ? 'Your product was deactivated' : 'Your product was deleted',
      body: DONE_TEXT[r.outcome](r.productTitle),
      data: { requestId: r.id, productId: r.productId, shopId: r.shopId, outcome: r.outcome, scope: r.scope },
    });
  }
}

const AUDIT_ACTION = { DELETED: 'catalog.product_deleted', LISTING_DELETED: 'catalog.listing_deleted', DEACTIVATED: 'catalog.product_deactivated' };
const auditDeletion = (tx, { actorId, productId, outcome, via, requestId, title, shopId = null, scope = null }) =>
  tx.auditLog.create({
    data: { actorId, action: AUDIT_ACTION[outcome], entityType: 'Product', entityId: productId, meta: { title, via, requestId, shopId, scope } },
  });

/** Carries out one PENDING request now (approve or the job). Null if it is no longer PENDING. */
async function carryOutRequest(requestId, { actorId, via }) {
  const result = await withOrderFallback(async (tx, force) => {
    const done = { status: 'DONE', decidedAt: new Date(), decidedById: actorId };
    const claimed = await tx.productDeletionRequest.updateMany({ where: { id: requestId, status: 'PENDING' }, data: done });
    if (claimed.count !== 1) return null; // already decided by someone else
    const request = await tx.productDeletionRequest.findUnique({ where: { id: requestId } });
    const r = await carryOutInTx(tx, request, force);
    await tx.productDeletionRequest.update({ where: { id: requestId }, data: { outcome: r.outcome, scope: r.scope } });
    const requests = [{ ...request, outcome: r.outcome, scope: r.scope }];
    if (r.productGone) {
      // other shops' pending requests for the product are done too: their listings went with it
      const rest = await tx.productDeletionRequest.findMany({ where: { productId: request.productId, status: 'PENDING' } });
      await tx.productDeletionRequest.updateMany({ where: { id: { in: rest.map((x) => x.id) } }, data: { ...done, outcome: 'DELETED' } });
      requests.push(...rest.map((x) => ({ ...x, outcome: 'DELETED' })));
    }
    await auditDeletion(tx, {
      actorId,
      productId: request.productId,
      outcome: r.outcome,
      via,
      requestId,
      title: request.productTitle,
      shopId: request.shopId,
      scope: r.scope,
    });
    return { outcome: r.outcome, scope: r.scope, keys: r.keys, requests };
  });
  if (result) await finish(result);
  return result;
}

/** Admin: deletes (or deactivates) any product now and closes every PENDING request for it. */
async function deleteProductNow(productId, { actorId, via }) {
  const result = await withOrderFallback(async (tx, force) => {
    const r = await purgeInTx(tx, productId, force);
    if (!r) throw new AppError(404, 'Product not found');
    const requests = await tx.productDeletionRequest.findMany({ where: { productId, status: 'PENDING' } });
    await tx.productDeletionRequest.updateMany({
      where: { id: { in: requests.map((x) => x.id) } },
      data: { status: 'DONE', decidedAt: new Date(), decidedById: actorId, outcome: r.outcome },
    });
    await auditDeletion(tx, { actorId, productId, outcome: r.outcome, via, requestId: requests[0]?.id ?? null, title: r.title });
    return { outcome: r.outcome, keys: r.keys, requests: requests.map((x) => ({ ...x, outcome: r.outcome })) };
  });
  await finish(result);
  return result;
}

// ---------- shop owner ----------

export async function requestDeletion(user, shopId, productId, { reason }) {
  await ownerShop(user, shopId);
  const listing = await prisma.shopListing.findUnique({
    where: { shopId_productId: { shopId, productId } },
    select: { id: true, isActive: true, product: { select: { title: true, isActive: true, lockedAt: true, createdByShopId: true } } },
  });
  if (!listing) throw new AppError(404, 'Product not found'); // the shop must have a listing of it
  const { product } = listing;
  const scope = ownsProduct(product, shopId) && (await otherActiveListings(prisma, productId, shopId)) === 0 ? 'PRODUCT' : 'LISTING';

  const now = new Date();
  let request;
  try {
    request = await prisma.$transaction(async (tx) => {
      const r = await tx.productDeletionRequest.create({
        data: {
          productId,
          productTitle: product.title,
          productWasActive: product.isActive,
          listingWasActive: listing.isActive,
          scope,
          shopId,
          requestedById: user.id,
          reason: reason ?? null,
          autoDeleteAt: new Date(now.getTime() + PRODUCT_DELETION_HOURS * HOUR_MS),
        },
      });
      // hidden at once: this shop's listing, and for PRODUCT scope the product
      await tx.shopListing.update({ where: { id: listing.id }, data: { isActive: false } });
      if (scope === 'PRODUCT') await tx.product.update({ where: { id: productId }, data: { isActive: false } });
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          action: 'catalog.product_deletion_requested',
          entityType: 'Product',
          entityId: productId,
          meta: { requestId: r.id, shopId, scope },
        },
      });
      return r;
    });
  } catch (err) {
    if (err.code === 'P2002') throw new AppError(409, 'A deletion request for this product is already pending', { code: 'ALREADY_PENDING' });
    throw err;
  }

  await notify(await adminIds(), {
    type: 'PRODUCT_DELETION_REQUESTED',
    title: 'A shop asked to delete a product',
    body:
      scope === 'PRODUCT'
        ? `"${product.title}" will be deleted automatically in ${PRODUCT_DELETION_HOURS} hours unless you reject it.`
        : `A shop's listing of "${product.title}" will be deleted automatically in ${PRODUCT_DELETION_HOURS} hours unless you reject it.`,
    data: { requestId: request.id, productId, shopId },
  });
  return present(request);
}

export async function cancelRequest(user, shopId, id) {
  await ownerShop(user, shopId);
  const request = await prisma.productDeletionRequest.findFirst({ where: { id, shopId } });
  if (!request) throw new AppError(404, 'Deletion request not found');
  const updated = await prisma.$transaction(async (tx) => {
    const c = await tx.productDeletionRequest.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'CANCELLED', decidedAt: new Date() },
    });
    if (c.count !== 1) throw new AppError(409, 'Only a pending request can be cancelled', { code: 'NOT_PENDING' });
    await restoreHidden(tx, request);
    await tx.auditLog.create({
      data: { actorId: user.id, action: 'catalog.product_deletion_cancelled', entityType: 'Product', entityId: request.productId, meta: { requestId: id } },
    });
    return tx.productDeletionRequest.findUnique({ where: { id } });
  });
  return present(updated);
}

export async function listShopRequests(user, shopId, { status, page, limit }) {
  await ownerShop(user, shopId);
  const where = { shopId, ...(status && { status }) };
  const [total, rows] = await Promise.all([
    prisma.productDeletionRequest.count({ where }),
    prisma.productDeletionRequest.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
  ]);
  return pageOf(rows.map(present), total, page, limit);
}

// ---------- admin ----------

export async function listAdminRequests({ status, page, limit }) {
  const where = status ? { status } : {};
  const [total, rows] = await Promise.all([
    prisma.productDeletionRequest.count({ where }),
    prisma.productDeletionRequest.findMany({
      where,
      orderBy: status === 'PENDING' ? { autoDeleteAt: 'asc' } : { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: { shop: { select: { id: true, name: true, slug: true } } },
    }),
  ]);
  const products = await prisma.product.findMany({
    where: { id: { in: rows.map((r) => r.productId) } },
    select: { id: true, slug: true, title: true, isActive: true },
  });
  const byId = new Map(products.map((p) => [p.id, p]));
  const items = rows.map((r) => ({
    ...present(r),
    requestedById: r.requestedById,
    decidedById: r.decidedById,
    shop: r.shop,
    product: byId.get(r.productId) ?? null, // null once deleted (productTitle keeps the name)
  }));
  return pageOf(items, total, page, limit);
}

async function pendingRequest(id) {
  const request = await prisma.productDeletionRequest.findUnique({ where: { id } });
  if (!request) throw new AppError(404, 'Deletion request not found');
  if (request.status !== 'PENDING') throw new AppError(409, 'This request has already been decided', { code: 'NOT_PENDING' });
  return request;
}

export async function rejectRequest(admin, id, { note }) {
  const request = await pendingRequest(id);
  const updated = await prisma.$transaction(async (tx) => {
    const c = await tx.productDeletionRequest.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'REJECTED', rejectNote: note, decidedById: admin.id, decidedAt: new Date() },
    });
    if (c.count !== 1) throw new AppError(409, 'This request has already been decided', { code: 'NOT_PENDING' });
    await restoreHidden(tx, request);
    await tx.auditLog.create({
      data: { actorId: admin.id, action: 'catalog.product_deletion_rejected', entityType: 'Product', entityId: request.productId, meta: { requestId: id } },
    });
    return tx.productDeletionRequest.findUnique({ where: { id } });
  });
  await notifyOwner(request.shopId, {
    type: 'PRODUCT_DELETION_REJECTED',
    title: 'Your product deletion request was rejected',
    body: `"${request.productTitle}" stays and is visible again. Note from Vendors Hub: ${note}`,
    data: { requestId: id, productId: request.productId, shopId: request.shopId },
  });
  return present(updated);
}

export async function approveRequest(admin, id) {
  await pendingRequest(id);
  const result = await carryOutRequest(id, { actorId: admin.id, via: 'admin_approved' });
  if (!result) throw new AppError(409, 'This request has already been decided', { code: 'NOT_PENDING' });
  return present(await prisma.productDeletionRequest.findUnique({ where: { id } }));
}

export async function deletePermanently(admin, productId) {
  const result = await deleteProductNow(productId, { actorId: admin.id, via: 'admin' });
  return { productId, outcome: result.outcome };
}

// ---------- job ----------

const BATCH = 50;
const MAX_BATCHES = 10; // per run; the rest waits for the next run

/** Carries out every PENDING request due at `now` (a parameter so tests can move the clock). */
export async function sweepDeletionRequests(now = new Date()) {
  const result = { deleted: 0, listingsDeleted: 0, deactivated: 0 };
  for (let b = 0; b < MAX_BATCHES; b++) {
    const due = await prisma.productDeletionRequest.findMany({
      where: { status: 'PENDING', autoDeleteAt: { lte: now } },
      orderBy: { autoDeleteAt: 'asc' },
      select: { id: true },
      take: BATCH,
    });
    for (const r of due) {
      try {
        const done = await carryOutRequest(r.id, { actorId: null, via: 'auto' });
        if (done?.outcome === 'DELETED') result.deleted++;
        else if (done?.outcome === 'LISTING_DELETED') result.listingsDeleted++;
        else if (done) result.deactivated++;
      } catch (err) {
        result.failed = (result.failed ?? 0) + 1; // one bad request must not stop the others
        logger.error({ err, requestId: r.id }, 'product deletion request failed');
      }
    }
    if (due.length < BATCH) break;
  }
  return result;
}
