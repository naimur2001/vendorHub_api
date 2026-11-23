import { z } from 'zod';
import { ADMIN_NOTE_MAX } from '../../config/limits.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const listAdminOrdersQuery = z
  .object({
    status: z.enum(['PLACED', 'CONFIRMED', 'READY_FOR_PICKUP', 'OUT_FOR_DELIVERY', 'COMPLETED', 'CANCELLED']).optional(),
    shopId: z.string().uuid().optional(),
    deliveryMethod: z.enum(['STORE_PICKUP', 'VENDOR_DELIVERY', 'RESERVE_PICKUP']).optional(),
    paymentMethod: z.enum(['ONLINE', 'PAY_AT_STORE', 'CASH_ON_DELIVERY']).optional(),
    paymentStatus: z.enum(['PENDING', 'PAID', 'FAILED', 'REFUNDED']).optional(),
    q: z.string().trim().min(2).max(100).optional(), // order number, customer phone or email
    from: day.optional(), // Dhaka days, both inclusive
    to: day.optional(),
    late: z.enum(['unconfirmed', 'delivery', 'pickup', 'any']).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .refine((o) => !o.from || !o.to || o.from <= o.to, { message: '"from" must not be after "to"', path: ['from'] });

export const adminChatQuery = z.object({
  after: z.string().uuid().optional(),
});

export const adminCancelSchema = z.object({
  reason: z.string().trim().min(3).max(300),
});

export const adminNoteSchema = z.object({
  body: z.string().trim().min(1).max(ADMIN_NOTE_MAX),
});
