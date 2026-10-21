import { z } from 'zod';

const rating = z.number().int().min(1).max(5);

export const createReviewSchema = z
  .object({
    orderId: z.string().uuid(),
    type: z.enum(['PRODUCT', 'SHOP_TRUST']),
    productId: z.string().uuid().optional(),
    rating,
    comment: z.string().trim().max(1000).optional(),
  })
  .refine((d) => (d.type === 'PRODUCT' ? d.productId !== undefined : d.productId === undefined), {
    message: 'productId is required for PRODUCT reviews and not allowed for SHOP_TRUST reviews',
    path: ['productId'],
  });

export const updateReviewSchema = z
  .object({
    rating: rating.optional(),
    comment: z.string().trim().max(1000).nullable().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'Provide at least one field to update' });

export const productReviewsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});