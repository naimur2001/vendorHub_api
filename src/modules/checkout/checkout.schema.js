import { z } from 'zod';
import { couponCode } from '../promotions/promotions.schema.js';

const shopChoice = z.object({
  shopId: z.string().uuid(),
  // RESERVE_PICKUP: held for RESERVATION_HOURS, always paid at the store (PAY_AT_STORE)
  deliveryMethod: z.enum(['STORE_PICKUP', 'VENDOR_DELIVERY', 'RESERVE_PICKUP']),
  paymentMethod: z.enum(['ONLINE', 'PAY_AT_STORE', 'CASH_ON_DELIVERY']),
  // deliveryAddress: z.string().trim().min(10).max(300).optional(),
    deliveryAddress: z.string().trim().min(10).max(300).optional(),
    addressId: z.string().uuid().optional(), // a saved address of the customer, instead of typing one
    couponCode: couponCode.optional(), // a coupon of THIS shop; the discount is computed on the server
});

export const checkoutSchema = z.object({
  shops: z.array(shopChoice).min(1).max(20),
  // pay part of the orders with referral credit (at most 20% of each order's items after a coupon)
  useCredit: z.boolean().default(false),
});

export const listOrdersQuery = z.object({
  status: z
    .enum(['PLACED', 'CONFIRMED', 'READY_FOR_PICKUP', 'OUT_FOR_DELIVERY', 'COMPLETED', 'CANCELLED'])
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});