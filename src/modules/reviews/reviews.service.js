import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';

const reviewInclude = {
  user: { select: { name: true } },
  shop: { select: { id: true, name: true, slug: true } },
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
});

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
  return reviewOut(created);
}

export async function updateReview(user, id, data) {
  const review = await prisma.review.findFirst({ where: { id, userId: user.id } });
  if (!review) throw new AppError(404, 'Review not found');
  const updated = await prisma.review.update({ where: { id }, data, include: reviewInclude });
  return reviewOut(updated);
}

// The author can delete their review; an admin can delete any review (moderation).
export async function deleteReview(user, id) {
  const review = await prisma.review.findUnique({ where: { id } });
  if (!review || (review.userId !== user.id && user.role !== 'ADMIN')) {
    throw new AppError(404, 'Review not found');
  }
  await prisma.review.delete({ where: { id } });
}

export async function productReviews(slug, { page, limit }) {
  const product = await prisma.product.findFirst({
    where: { slug, isActive: true },
    select: { id: true },
  });
  if (!product) throw new AppError(404, 'Product not found');

  const where = { productId: product.id, type: 'PRODUCT' };
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