import { z } from 'zod';

const orderStatuses = ['PLACED', 'CONFIRMED', 'READY_FOR_PICKUP', 'OUT_FOR_DELIVERY', 'COMPLETED', 'CANCELLED'];

export const listShopOrdersQuery = z.object({
  status: z.enum(orderStatuses).optional(),
  paymentStatus: z.enum(['PENDING', 'PAID', 'FAILED', 'REFUNDED']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const updateStatusSchema = z
  .object({
    status: z.enum(['CONFIRMED', 'READY_FOR_PICKUP', 'OUT_FOR_DELIVERY', 'COMPLETED', 'CANCELLED']),
    reason: z.string().trim().min(3).max(300).optional(),
  })
  .refine((d) => d.status !== 'CANCELLED' || d.reason, {
    message: 'A reason is required when cancelling an order',
    path: ['reason'],
  });

export const cancelSchema = z.object({
  reason: z.string().trim().min(3).max(300).optional(),
});