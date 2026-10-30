import { z } from 'zod';

const shopChoice = z.object({
  shopId: z.string().uuid(),
  deliveryMethod: z.enum(['STORE_PICKUP', 'VENDOR_DELIVERY']),
  paymentMethod: z.enum(['ONLINE', 'PAY_AT_STORE', 'CASH_ON_DELIVERY']),
  // deliveryAddress: z.string().trim().min(10).max(300).optional(),
    deliveryAddress: z.string().trim().min(10).max(300).optional(),
    addressId: z.string().uuid().optional(), // a saved address of the customer, instead of typing one
});

export const checkoutSchema = z.object({
  shops: z.array(shopChoice).min(1).max(20),
});

export const listOrdersQuery = z.object({
  status: z
    .enum(['PLACED', 'CONFIRMED', 'READY_FOR_PICKUP', 'OUT_FOR_DELIVERY', 'COMPLETED', 'CANCELLED'])
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});