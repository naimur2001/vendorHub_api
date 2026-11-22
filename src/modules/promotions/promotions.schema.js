import { z } from 'zod';

export const couponCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{4,16}$/, 'A coupon code is 4-16 letters A-Z or digits');

const date = z.coerce.date();

export const createDealSchema = z.object({
  listingId: z.uuid(),
  dealPrice: z.number().int().min(1),
  startsAt: date.optional(), // default: now
  endsAt: date,
  maxQty: z.number().int().min(1).max(100000).nullable().optional(),
});

export const createCouponSchema = z
  .object({
    code: couponCode,
    percentOff: z.number().int().min(1).max(90).optional(),
    amountOff: z.number().int().min(1).max(1000000).optional(),
    minOrder: z.number().int().min(0).max(10000000).optional(),
    startsAt: date.optional(),
    endsAt: date,
    maxUses: z.number().int().min(1).max(1000000).nullable().optional(),
    perCustomer: z.number().int().min(1).max(10).optional(),
  })
  .refine((c) => (c.percentOff === undefined) !== (c.amountOff === undefined), {
    message: 'Give exactly one of percentOff or amountOff',
    path: ['percentOff'],
  });

export const updateCouponSchema = z
  .object({
    isActive: z.boolean().optional(),
    endsAt: date.optional(),
    maxUses: z.number().int().min(1).max(1000000).nullable().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'Provide at least one field to update' });

export const publicDealsQuery = z.object({ limit: z.coerce.number().int().min(1).max(30).default(12) });
