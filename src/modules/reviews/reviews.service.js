import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { processImage } from '../../lib/images.js';
import { stageImage, removeImage, imageUrls } from '../../lib/storage.js';
import { MAX_REVIEW_PHOTOS } from '../../config/limits.js';
import { autoFlagReview } from '../moderation/moderation.service.js';

// the visible photos of a review (hidden ones are left out), in order
export const photosInclude = {
  where: { isHidden: false },
  orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  include: { image: { select: { key: true, width: true, height: true } } },
};
export const presentPhotos = (photos = []) =>
  photos.map((p) => ({ id: p.id, ...imageUrls(p.image.key), width: p.image.width, height: p.image.height }));

const reviewInclude = {
  user: { select: { name: true } },
  shop: { select: { id: true, name: true, slug: true } },
  photos: photosInclude,
};

const reviewOut = (r) => ({
  id: r.id,
  type: r.type,
  rating: r.rating,
  comment: r.comment,
  createdAt: r.createdAt,
  reviewer: r.user?.name ?? null,
  shop: r.shop ? { id: r.shop.id, name: r.shop.name, slug: r.shop.slug } : null,
  productId: r.productId,
  photos: presentPhotos(r.photos),
});

// ---------- review photos (verified buyers only) ----------
// The author only; and they must still be a verified buyer: a COMPLETED order at that shop
// (for a PRODUCT review: with that product). Same pipeline as product photos (WebP, 5 MB).
async function ownReview(user, reviewId) {
  const review = await prisma.review.findFirst({ where: { id: reviewId, userId: user.id } });
  if (!review) throw new AppError(404, 'Review not found');
  return review;
}

export async function addReviewPhoto(user, reviewId, file) {
  if (!file) throw new AppError(400, 'Send exactly one photo in the multipart field "image"');
  const review = await ownReview(user, reviewId);
  const bought = await prisma.subOrder.count({
    where: {
      checkout: { userId: user.id },
      shopId: review.shopId,
      status: 'COMPLETED',
      ...(review.productId && { items: { some: { listing: { productId: review.productId } } } }),
    },
  });
  if (!bought) throw new AppError(403, 'Only verified buyers can add photos', { code: 'NOT_VERIFIED_BUYER' });
  const count = await prisma.reviewPhoto.count({ where: { reviewId } });
  if (count >= MAX_REVIEW_PHOTOS) throw new AppError(409, `At most ${MAX_REVIEW_PHOTOS} photos per review`, { code: 'REVIEW_PHOTO_LIMIT' });

  const processed = await processImage(file.buffer, 'REVIEW');
  const staged = await stageImage(processed);
  await staged.commit();
  try {
    const photo = await prisma.$transaction(async (tx) => {
      // again under a lock: two uploads at once cannot make a fourth photo
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`review-photos:${reviewId}`}))`;
      const n = await tx.reviewPhoto.count({ where: { reviewId } });
      if (n >= MAX_REVIEW_PHOTOS) throw new AppError(409, `At most ${MAX_REVIEW_PHOTOS} photos per review`, { code: 'REVIEW_PHOTO_LIMIT' });
      const image = await tx.image.create({
        data: { key: staged.key, width: processed.width, height: processed.height, purpose: 'REVIEW', ownerId: user.id },
      });
      return tx.reviewPhoto.create({ data: { reviewId, imageId: image.id, sortOrder: n }, include: { image: true } });
    });
    return presentPhotos([photo])[0];
  } catch (err) {
    await removeImage(staged.key).catch(() => {});
    throw err;
  }
}

// The author, or an admin, removes a photo (row and files).
export async function removeReviewPhoto(user, reviewId, photoId) {
  const photo = await prisma.reviewPhoto.findFirst({ where: { id: photoId, reviewId }, include: { review: true, image: true } });
  if (!photo || (photo.review.userId !== user.id && user.role !== 'ADMIN')) throw new AppError(404, 'Photo not found');
  await prisma.image.delete({ where: { id: photo.imageId } }); // cascades to the ReviewPhoto row
  await removeImage(photo.image.key).catch(() => {});
}

export async function createReview(user, { orderId, type, productId, rating, comment }) {
  const order = await prisma.subOrder.findFirst({
    where: { id: orderId, checkout: { userId: user.id } },
    include: { items: { include: { listing: { select: { productId: true } } } } },
  });
  if (!order) throw new AppError(404, 'Order not found');
  if (order.status !== 'COMPLETED') {
    throw new AppError(409, 'You can review an order after it is completed');
  }
  if (type === 'PRODUCT' && !order.items.some((i) => i.listing.productId === productId)) {
    throw new AppError(400, 'That product is not in this order');
  }

  const existing = await prisma.review.findFirst({
    where: {
      userId: user.id,
      shopId: order.shopId,
      type,
      ...(type === 'PRODUCT' && { productId }),
    },
    select: { id: true },
  });
  if (existing) {
    throw new AppError(409, 'You have already reviewed this. Edit your existing review instead.', {
      reviewId: existing.id,
    });
  }

  const created = await prisma.review.create({
    data: {
      type,
      userId: user.id,
      shopId: order.shopId,
      productId: type === 'PRODUCT' ? productId : null,
      rating,
      comment: comment ?? null,
    },
    include: reviewInclude,
  });
  await autoFlagReview(created); // links, phone numbers or repeated text -> an OPEN flag for the admins
  return reviewOut(created);
}

export async function updateReview(user, id, data) {
  const review = await prisma.review.findFirst({ where: { id, userId: user.id } });
  if (!review) throw new AppError(404, 'Review not found');
  const updated = await prisma.review.update({ where: { id }, data, include: reviewInclude });
  if ('comment' in data) await autoFlagReview(updated);
  return reviewOut(updated);
}

// The author can delete their review; an admin can delete any review (moderation).
export async function deleteReview(user, id) {
  const review = await prisma.review.findUnique({ where: { id } });
  if (!review || (review.userId !== user.id && user.role !== 'ADMIN')) {
    throw new AppError(404, 'Review not found');
  }
  // its photos too: the Image rows and the files (no orphans left in uploads/media)
  const photos = await prisma.reviewPhoto.findMany({ where: { reviewId: id }, include: { image: true } });
  await prisma.$transaction([
    prisma.image.deleteMany({ where: { id: { in: photos.map((p) => p.imageId) } } }),
    prisma.review.delete({ where: { id } }),
  ]);
  await Promise.all(photos.map((p) => removeImage(p.image.key).catch(() => {})));
}

export async function productReviews(slug, { page, limit }) {
  const product = await prisma.product.findFirst({
    where: { slug, isActive: true, moderationStatus: 'APPROVED' },
    select: { id: true },
  });
  if (!product) throw new AppError(404, 'Product not found');

  const where = { productId: product.id, type: 'PRODUCT', isHidden: false }; // hidden by moderation: left out
  const [total, rows, agg, groups] = await Promise.all([
    prisma.review.count({ where }),
    prisma.review.findMany({
      where,
      include: reviewInclude,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.review.aggregate({ where, _avg: { rating: true } }),
    prisma.review.groupBy({ by: ['rating'], where, _count: { rating: true } }),
  ]);

  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const g of groups) distribution[g.rating] = g._count.rating;

  return {
    items: rows.map(reviewOut),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    summary: {
      average: total > 0 ? Math.round(agg._avg.rating * 10) / 10 : null,
      count: total,
      distribution,
    },
  };
}